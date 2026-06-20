-- 0012_paypal_subscription.sql
-- PayPal 구독 결제 (제한국가 Premium) — 백엔드요청_구독결제_PayPal.md §1, §3 대응
--
-- 제한국가 유저는 PayPal 구독으로 Premium을 이용한다. (허용국가는 기존 UID 연동 유지)
-- Premium 게이트는 기존과 동일하게 users.tier('free'|'premium') 단일 기준이며,
-- 백엔드가 PayPal 상태와 항상 정합성을 유지한다:
--   subscription_status active/canceling -> tier='premium'
--   subscription_status none/past_due    -> tier='free'
-- 활성화의 SSOT는 PayPal Webhook이다(프론트 콜백으로 tier를 켜지 않는다).
--
-- 실행: Supabase SQL Editor에서 전체 실행.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) users 구독 컬럼 5개 추가
-- ─────────────────────────────────────────────────────────────────────────────
-- 프론트는 이 컬럼들을 본인 행 read(기존 users_select_own RLS 정책)로 읽어
-- 배지/결제일/해지/실패 안내에 표시용으로만 사용한다.
-- paypal_subscription_id는 백엔드 내부용(프론트 select 대상 아님).
alter table public.users
  add column if not exists subscription_status text not null default 'none'
    check (subscription_status in ('none', 'active', 'canceling', 'past_due')),
  add column if not exists subscription_next_billing_at timestamptz,
  add column if not exists subscription_plan text
    check (subscription_plan in ('trial', 'regular')),
  add column if not exists subscription_last_payment_status text,
  add column if not exists paypal_subscription_id text;

-- PayPal subscription id로 유저를 역조회(Webhook 처리)하기 위한 인덱스.
-- 부분 unique: 같은 구독 id가 두 유저에 붙는 것을 방지(NULL은 중복 허용).
create unique index if not exists users_paypal_subscription_id_key
  on public.users (paypal_subscription_id)
  where paypal_subscription_id is not null;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) activity_logs type 제약 확장 (구독 이벤트 로깅)
-- ─────────────────────────────────────────────────────────────────────────────
-- 기존 type CHECK 제약이 있으면 교체한다(제약명은 환경에 따라 다를 수 있어 동적으로 탐색).
-- 제약이 없으면(이미 자유 text면) 이 블록은 아무 것도 하지 않는다.
do $$
declare
  v_conname text;
begin
  select c.conname into v_conname
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
   where t.relname = 'activity_logs'
     and c.contype = 'c'
     and pg_get_constraintdef(c.oid) ilike '%type%';

  if v_conname is not null then
    execute format('alter table public.activity_logs drop constraint %I', v_conname);
    alter table public.activity_logs
      add constraint activity_logs_type_check check (type in (
        'UID_APPLIED', 'UID_APPROVED', 'UID_REJECTED', 'UID_CHANGE_REQUESTED',
        'TIER_CHANGED', 'PREMIUM_AUTO_APPROVED', 'ADMIN_MANUAL_CHANGE',
        'SUBSCRIPTION_ACTIVATED', 'SUBSCRIPTION_RENEWED',
        'SUBSCRIPTION_PAYMENT_FAILED', 'SUBSCRIPTION_CANCEL_REQUESTED',
        'SUBSCRIPTION_CANCELED'
      ));
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3) 구독 이벤트 원자 처리 RPC
-- ─────────────────────────────────────────────────────────────────────────────
-- Webhook 핸들러가 호출한다. paypal_subscription_id로 유저를 찾아
-- tier + subscription_* 를 한 트랜잭션에서 갱신하고 activity_logs를 남긴다.
-- 멱등성: tier 변경이 없으면 TIER_CHANGED 로그를 남기지 않는다.
--
-- p_event:
--   'ACTIVATED'      첫 결제 성공/활성화 -> tier=premium, status=active
--   'RENEWED'        갱신 결제 성공      -> next_billing 갱신, last_payment=succeeded (tier 유지)
--   'PAYMENT_FAILED' 자동결제 실패        -> 즉시 tier=free, status=past_due (유예 없음)
--   'CANCELED'       기간 종료 도달       -> tier=free, status=none
--
-- p_next_billing_at: ACTIVATED/RENEWED 시 다음 결제일(=Premium 종료 예정일). 그 외 NULL 허용.
-- p_plan: 'trial' | 'regular' (ACTIVATED/RENEWED 시 세팅). 그 외 NULL 허용.
create or replace function apply_subscription_event(
  p_paypal_sub_id   text,
  p_event           text,
  p_next_billing_at timestamptz default null,
  p_plan            text default null
)
returns jsonb
language plpgsql
as $$
declare
  v_user     users%rowtype;
  v_old_tier text;
  v_new_tier text;
begin
  if p_event not in ('ACTIVATED', 'RENEWED', 'PAYMENT_FAILED', 'CANCELED') then
    return jsonb_build_object('ok', false, 'reason', 'invalid_event');
  end if;

  -- 구독 id로 유저 잠금 조회
  select * into v_user
    from users
   where paypal_subscription_id = p_paypal_sub_id
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'subscription_not_found');
  end if;

  v_old_tier := v_user.tier;

  if p_event = 'ACTIVATED' then
    v_new_tier := 'premium';
    update users set
      tier                            = 'premium',
      subscription_status             = 'active',
      subscription_plan               = coalesce(p_plan, subscription_plan),
      subscription_next_billing_at    = coalesce(p_next_billing_at, subscription_next_billing_at),
      subscription_last_payment_status = 'succeeded'
    where id = v_user.id;

    insert into activity_logs (user_id, type, from_tier, to_tier)
    values (v_user.id, 'SUBSCRIPTION_ACTIVATED', v_old_tier, 'premium');

  elsif p_event = 'RENEWED' then
    -- 갱신 결제 성공: 해지 예약(canceling)이 아닌 한 active 유지.
    v_new_tier := 'premium';
    update users set
      tier                            = 'premium',
      subscription_status             = case when subscription_status = 'canceling'
                                             then 'canceling' else 'active' end,
      subscription_plan               = coalesce(p_plan, 'regular'),
      subscription_next_billing_at    = coalesce(p_next_billing_at, subscription_next_billing_at),
      subscription_last_payment_status = 'succeeded'
    where id = v_user.id;

    insert into activity_logs (user_id, type)
    values (v_user.id, 'SUBSCRIPTION_RENEWED');

  elsif p_event = 'PAYMENT_FAILED' then
    -- 요구사항: 결제 실패 = 유예 없이 즉시 Basic.
    v_new_tier := 'free';
    update users set
      tier                            = 'free',
      subscription_status             = 'past_due',
      subscription_last_payment_status = 'failed'
    where id = v_user.id;

    insert into activity_logs (user_id, type)
    values (v_user.id, 'SUBSCRIPTION_PAYMENT_FAILED');

  else  -- CANCELED (기간 종료 도달)
    v_new_tier := 'free';
    update users set
      tier                         = 'free',
      subscription_status          = 'none',
      subscription_next_billing_at = null
    where id = v_user.id;

    insert into activity_logs (user_id, type)
    values (v_user.id, 'SUBSCRIPTION_CANCELED');
  end if;

  -- 등급 변경 시 TIER_CHANGED 로그
  if v_old_tier is distinct from v_new_tier then
    insert into activity_logs (user_id, type, from_tier, to_tier)
    values (v_user.id, 'TIER_CHANGED', v_old_tier, v_new_tier);
  end if;

  return jsonb_build_object(
    'ok', true,
    'userId', v_user.id,
    'event', p_event,
    'tier', v_new_tier
  );
end;
$$;
grant execute on function apply_subscription_event(text, text, timestamptz, text) to service_role;

-- 주의
-- - 해지(요청서 §2.2)는 즉시 Basic이 아니라 기간말까지 status='canceling' 유지 후 종료다.
--   해지 요청 시점에는 이 RPC가 아니라 엔드포인트가 직접
--   subscription_status='canceling'(tier='premium' 유지)으로 갱신하고,
--   기간 종료 시 PayPal CANCELED Webhook이 와서 위 'CANCELED' 분기로 free 전환한다.
-- - paypal_subscription_id는 구독 생성 엔드포인트(/api/subscription/create)가
--   PayPal subscription 생성 직후 users 행에 기록한다.
