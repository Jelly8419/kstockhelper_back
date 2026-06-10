-- 0001_premium_applications.sql
-- 프리미엄 회원 신청 관리 (PRD: premium_applications_prd.md)
--
-- 신청 이력을 row 단위로 보존하는 applications 테이블을 도입한다.
-- 승인/거절은 앱이 호출하는 단일 RPC(process_premium_application)로 원자적으로 처리하며,
-- 기존 Binance 자동 트리거 2개는 제거해 처리 로직을 앱 코드로 일원화한다.
--
-- 실행: Supabase SQL Editor에서 전체 실행.

-- 1) applications: 거래소 UID 신청 이력 (PRD 4.2). UID 입력/변경마다 row insert.
create table if not exists applications (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id),
  exchange     text not null check (exchange in ('BINANCE', 'BYBIT')),
  uid          text not null,
  status       text not null default 'PENDING' check (status in ('PENDING', 'APPROVED', 'REJECTED')),
  applied_at   timestamptz not null default now(),
  processed_at timestamptz
);
-- 목록 조회(status='PENDING' + applied_at 오름차순)용 인덱스
create index if not exists applications_status_applied_idx on applications (status, applied_at);
create index if not exists applications_user_id_idx on applications (user_id);
grant select, insert, update on public.applications to service_role;   -- delete 미부여(이력 보존)
alter table public.applications disable row level security;

-- 2) 기존 Binance 자동 트리거 제거 — 승인 로직을 RPC/앱으로 일원화
drop trigger if exists trg_binance_approved on users;
drop function if exists fn_binance_approved_to_premium();
drop trigger if exists trg_binance_approved_log on users;
drop function if exists fn_binance_approved_log();

-- 3) 승인/거절 원자 처리 RPC.
--    applications + users(uid_status, tier) + activity_logs 를 한 트랜잭션에서 처리.
--    PENDING 조건부 업데이트로 중복 처리(race) 차단 → 영향 0이면 'already_processed' 반환.
--    비활성(inactive) 회원은 'inactive_user' 반환.
--    거절 시 다른 거래소 approved UID가 없으면 tier='free'로 강등(PRD 4.9).
create or replace function process_premium_application(
  p_application_id uuid,
  p_status         text   -- 'APPROVED' | 'REJECTED'
)
returns jsonb
language plpgsql
as $$
declare
  v_app          applications%rowtype;
  v_user         users%rowtype;
  v_other_status text;
  v_old_tier     text;
  v_new_tier     text;
  v_processed_at timestamptz := now();
begin
  if p_status not in ('APPROVED', 'REJECTED') then
    return jsonb_build_object('ok', false, 'reason', 'invalid_status');
  end if;

  -- 신청 건 잠금 조회
  select * into v_app from applications where id = p_application_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  -- 회원 잠금 조회 + 비활성 차단
  select * into v_user from users where id = v_app.user_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if coalesce(v_user.status, 'active') = 'inactive' then
    return jsonb_build_object('ok', false, 'reason', 'inactive_user');
  end if;

  -- 조건부(PENDING) 업데이트 — 이미 처리됐으면 0행 → 차단
  update applications
     set status = p_status, processed_at = v_processed_at
   where id = p_application_id and status = 'PENDING';
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'already_processed');
  end if;

  v_old_tier := v_user.tier;

  if p_status = 'APPROVED' then
    v_new_tier := 'premium';
    if v_app.exchange = 'BINANCE' then
      update users set binance_uid_status = 'approved', tier = 'premium' where id = v_user.id;
    else
      update users set bybit_uid_status = 'approved', tier = 'premium' where id = v_user.id;
    end if;

    insert into activity_logs (user_id, type, exchange, uid)
    values (v_user.id, 'UID_APPROVED', v_app.exchange, v_app.uid);

  else  -- REJECTED
    -- 반대편 거래소 approved 여부로 tier 결정 (PRD 4.9)
    if v_app.exchange = 'BINANCE' then
      v_other_status := v_user.bybit_uid_status;
    else
      v_other_status := v_user.binance_uid_status;
    end if;
    v_new_tier := case when v_other_status = 'approved' then v_old_tier else 'free' end;

    if v_app.exchange = 'BINANCE' then
      update users set binance_uid_status = 'rejected', tier = v_new_tier where id = v_user.id;
    else
      update users set bybit_uid_status = 'rejected', tier = v_new_tier where id = v_user.id;
    end if;

    insert into activity_logs (user_id, type, exchange, uid)
    values (v_user.id, 'UID_REJECTED', v_app.exchange, v_app.uid);
  end if;

  -- 등급 변경 시 TIER_CHANGED 로그
  if v_old_tier is distinct from v_new_tier then
    insert into activity_logs (user_id, type, from_tier, to_tier)
    values (v_user.id, 'TIER_CHANGED', v_old_tier, v_new_tier);
  end if;

  return jsonb_build_object(
    'ok', true,
    'applicationId', v_app.id,
    'status', p_status,
    'processedAt', v_processed_at
  );
end;
$$;
grant execute on function process_premium_application(uuid, text) to service_role;

-- 주의
-- - 트리거 제거 후에는 대시보드에서 binance_uid_status를 직접 바꿔도 tier/로그가 자동 반영되지 않는다.
--   모든 승인/거절은 PATCH /internal/admin/premium-applications/{id}/status 로 처리한다.
-- - 신청 적재: POST /api/binance/connect 시 users.binance_uid_status='pending'과 함께
--   applications에 PENDING row를 insert한다.
