-- 0013_subscription_refunded.sql
-- 환불(refund) 처리 — 이벤트로그 property 시트정렬 회신 §2 대응
--
-- 프론트/PM 확정 정책: 환불 완료 시 tier='free' 즉시 전환(Premium 회수).
--   MVP는 "전액환불 = free 전환"만 처리한다. 부분환불(일할 환불 등)은 1차 범위 밖 —
--   실제 발생 가능성이 확인되면 별도 협의로 tier 유지/회수 정책을 정한다.
--
-- 이 마이그레이션은 0012의 apply_subscription_event RPC에 'REFUNDED' 분기를 추가하고,
-- activity_logs type 제약에 'SUBSCRIPTION_REFUNDED'를 더한다.
--
-- 실행: Supabase SQL Editor에서 전체 실행. (0012가 선행 적용되어 있어야 함)

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) activity_logs type 제약에 SUBSCRIPTION_REFUNDED 추가
-- ─────────────────────────────────────────────────────────────────────────────
-- 0012에서 만든 제약을 교체한다(없으면 아무 것도 안 함 — 0012와 동일한 동적 탐색 패턴).
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
        'SUBSCRIPTION_CANCELED', 'SUBSCRIPTION_REFUNDED'
      ));
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) apply_subscription_event RPC에 'REFUNDED' 분기 추가
-- ─────────────────────────────────────────────────────────────────────────────
-- REFUNDED: 환불 완료 -> tier=free, status=none (CANCELED와 동일한 결과 상태이나
--           activity_log는 SUBSCRIPTION_REFUNDED로 별도 기록 → 해지/환불 구분 가능).
-- next_billing은 비운다(더 이상 결제 없음). last_payment_status='refunded'로 표시.
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
  if p_event not in ('ACTIVATED', 'RENEWED', 'PAYMENT_FAILED', 'CANCELED', 'REFUNDED') then
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

  elsif p_event = 'REFUNDED' then
    -- 환불 완료 = 즉시 Premium 회수(전액환불 가정, MVP). 부분환불은 범위 밖.
    v_new_tier := 'free';
    update users set
      tier                            = 'free',
      subscription_status             = 'none',
      subscription_next_billing_at    = null,
      subscription_last_payment_status = 'refunded'
    where id = v_user.id;

    insert into activity_logs (user_id, type)
    values (v_user.id, 'SUBSCRIPTION_REFUNDED');

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
