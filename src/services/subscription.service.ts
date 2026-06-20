// 구독 DB 헬퍼 — users 테이블의 subscription_* 컬럼과 apply_subscription_event RPC를 다룬다.
// PayPal REST 호출은 paypal.service.ts, 지역 검증은 geoRegion.ts가 담당하고
// 이 파일은 Supabase(service_role) 쓰기/읽기만 담당한다.

import { supabase } from '../config/supabase';
import { logger } from '../utils/logger';

export type SubscriptionStatus = 'none' | 'active' | 'canceling' | 'past_due';
export type SubscriptionPlan = 'trial' | 'regular';

export interface UserSubscriptionRow {
  id: string;
  tier: string;
  subscription_status: SubscriptionStatus;
  subscription_next_billing_at: string | null;
  subscription_plan: SubscriptionPlan | null;
  subscription_last_payment_status: string | null;
  paypal_subscription_id: string | null;
}

const SUB_SELECT =
  'id, tier, subscription_status, subscription_next_billing_at, subscription_plan, subscription_last_payment_status, paypal_subscription_id';

/** userId로 구독 관련 행을 조회한다. 없으면 null. */
export async function getUserSubscription(userId: string): Promise<UserSubscriptionRow | null> {
  const { data, error } = await supabase
    .from('users')
    .select(SUB_SELECT)
    .eq('id', userId)
    .maybeSingle();

  if (error) {
    logger.error('구독 행 조회 실패:', error.message);
    throw error;
  }
  return (data as UserSubscriptionRow | null) ?? null;
}

/**
 * 구독 생성 직후 PayPal subscription ID를 유저 행에 기록한다.
 * 아직 활성화 전(APPROVAL_PENDING)이므로 tier/subscription_status는 건드리지 않는다.
 * 활성화는 Webhook(ACTIVATED)이 SSOT.
 * @returns 업데이트된 행 존재 여부(userId 없으면 false)
 */
export async function attachPaypalSubscriptionId(
  userId: string,
  paypalSubscriptionId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('users')
    .update({ paypal_subscription_id: paypalSubscriptionId })
    .eq('id', userId)
    .select('id');

  if (error) {
    logger.error('paypal_subscription_id 기록 실패:', error.message);
    throw error;
  }
  return (data?.length ?? 0) > 0;
}

/**
 * 해지 예약 — 기간말 해지. tier='premium'은 유지하고 status만 'canceling'으로 바꾼다.
 * subscription_next_billing_at(=Premium 종료 예정일)은 그대로 둔다.
 * active 상태인 행에서만 동작(멱등성: 이미 canceling/none이면 0행).
 * @returns 업데이트된 행 존재 여부
 */
export async function markCanceling(userId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('users')
    .update({ subscription_status: 'canceling' })
    .eq('id', userId)
    .eq('subscription_status', 'active')
    .select('id');

  if (error) {
    logger.error('구독 해지 예약 실패:', error.message);
    throw error;
  }
  return (data?.length ?? 0) > 0;
}

export type SubscriptionEvent = 'ACTIVATED' | 'RENEWED' | 'PAYMENT_FAILED' | 'CANCELED';

export interface ApplyEventResult {
  ok: boolean;
  reason?: string;
  userId?: string;
  tier?: string;
}

/**
 * Webhook 핸들러용 — apply_subscription_event RPC를 호출해 tier/subscription_*를
 * 원자적으로 갱신한다(0012 마이그레이션). paypal_subscription_id로 유저를 찾는다.
 */
export async function applySubscriptionEvent(
  paypalSubscriptionId: string,
  event: SubscriptionEvent,
  opts: { nextBillingAt?: string | null; plan?: SubscriptionPlan | null } = {},
): Promise<ApplyEventResult> {
  const { data, error } = await supabase.rpc('apply_subscription_event', {
    p_paypal_sub_id: paypalSubscriptionId,
    p_event: event,
    p_next_billing_at: opts.nextBillingAt ?? null,
    p_plan: opts.plan ?? null,
  });

  if (error) {
    logger.error('apply_subscription_event RPC 실패:', error.message);
    throw error;
  }

  const result = (data ?? {}) as { ok?: boolean; reason?: string; userId?: string; tier?: string };
  return {
    ok: result.ok === true,
    reason: result.reason,
    userId: result.userId,
    tier: result.tier,
  };
}
