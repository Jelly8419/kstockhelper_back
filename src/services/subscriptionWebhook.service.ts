// PayPal Webhook 이벤트 → 내부 구독 이벤트 매핑 (활성화의 SSOT).
// 서명 검증은 라우트에서 끝낸 뒤 이 핸들러가 event_type을 보고 apply_subscription_event RPC를 호출한다.
//
// 매핑(요청서 §3):
//  BILLING.SUBSCRIPTION.ACTIVATED        → ACTIVATED      (tier=premium, status=active)
//  PAYMENT.SALE.COMPLETED                → RENEWED        (next_billing 갱신, 결제 성공)
//  BILLING.SUBSCRIPTION.PAYMENT.FAILED   → PAYMENT_FAILED (즉시 free, status=past_due)
//  BILLING.SUBSCRIPTION.CANCELLED        → CANCELED       (기간 종료 도달, free)
//  BILLING.SUBSCRIPTION.EXPIRED          → CANCELED       (만료도 동일하게 free 처리)
//  PAYMENT.SALE.REFUNDED / PAYMENT.CAPTURE.REFUNDED → REFUNDED (환불 완료, 즉시 free)
//
// 그 외 이벤트(CREATED/UPDATED 등)는 무시한다.

import { logger } from '../utils/logger';
import { logAnalyticsEvent } from './subscription.service';
import type {
  SubscriptionEvent,
  SubscriptionPlan,
  ApplyEventResult,
} from './subscription.service';

// 내부 구독 이벤트 → 애널리틱스 events.event_name (이벤트로그 요청서 §3).
const ANALYTICS_EVENT_NAME: Partial<Record<SubscriptionEvent, string>> = {
  ACTIVATED: 'subscription_activated',
  RENEWED: 'subscription_renewed',
  PAYMENT_FAILED: 'subscription_payment_failed',
  CANCELED: 'subscription_cancelled',
  REFUNDED: 'subscription_refunded',
};

interface PayPalWebhookEvent {
  event_type?: string;
  resource?: {
    id?: string; // subscription id (BILLING.SUBSCRIPTION.*) — I-XXXX
    billing_agreement_id?: string; // subscription id (PAYMENT.SALE.* 갱신 결제)
    custom_id?: string;
    plan_id?: string;
    billing_info?: { next_billing_time?: string };
    // PAYMENT.SALE.COMPLETED는 resource.amount.{total,currency}에 실결제액이 온다.
    // BILLING.SUBSCRIPTION.* 이벤트엔 금액이 없어 plan 가격 상수로 폴백한다.
    amount?: { total?: string; currency?: string; value?: string; currency_code?: string };
    status_change_note?: string; // 해지/실패 사유가 담길 수 있음(없을 때 많음)
    reason?: string; // 환불 사유(refund webhook에 담길 수 있음)
    [k: string]: unknown;
  };
}

// 시트 스펙 고정값 (이벤트로그 property 시트정렬 요청서 §2.1).
// plan은 현재 1종(K-Stock Helper Premium Monthly)뿐이라 식별자 대신 통일 문자열을 쓴다.
const PAYMENT_PROVIDER = 'paypal';
const PLAN_NAME = 'premium_monthly'; // 프론트와 동일 값(§4 통일)
const DEFAULT_CURRENCY = 'USD';
// createPaypalPlan.ts의 가격: trial $1.00 / regular $4.90. 금액 미동봉 이벤트의 폴백.
const TRIAL_PRICE = 1.0;
const REGULAR_PRICE = 4.9;

interface PaymentMeta {
  payment_provider: string;
  plan_name: string;
  amount: number | null;
  amount_estimated: boolean; // true면 실결제액이 아닌 plan 가격 추정치(프론트 회신 §1)
  currency: string;
  billing_cycle: string | null;
  failure_reason: string | null;
}

/**
 * webhook resource에서 시트 스펙 결제 메타데이터를 뽑는다(요청서 §2).
 * - amount/currency: PAYMENT.SALE.COMPLETED는 resource.amount에서 파싱.
 *   금액이 없는 BILLING.SUBSCRIPTION.* 는 billing_cycle에 따라 plan 가격으로 폴백.
 * - billing_cycle: ACTIVATED=trial(첫 결제), RENEWED=monthly. 그 외(실패/해지)는 null.
 * - failure_reason: PayPal이 명시 사유를 안 주는 경우가 많아 가능할 때만 채운다.
 */
function extractPaymentMeta(
  eventType: string,
  internalEvent: SubscriptionEvent,
  resource: PayPalWebhookEvent['resource'],
): PaymentMeta {
  const billingCycle =
    internalEvent === 'ACTIVATED' ? 'trial' : internalEvent === 'RENEWED' ? 'monthly' : null;

  // 실결제 금액(PAYMENT.SALE.COMPLETED). amount.total 또는 amount.value.
  const rawTotal = resource?.amount?.total ?? resource?.amount?.value;
  const parsed = rawTotal !== undefined ? Number(rawTotal) : NaN;
  let amount: number | null = Number.isFinite(parsed) ? parsed : null;
  // 실측 여부: resource.amount에서 직접 파싱했으면 실측, plan 가격 폴백이면 추정.
  let amountEstimated = false;
  // 금액 미동봉 이벤트는 plan 가격으로 폴백(activated=trial, renewed=monthly만).
  if (amount === null) {
    if (billingCycle === 'trial') {
      amount = TRIAL_PRICE;
      amountEstimated = true;
    } else if (billingCycle === 'monthly') {
      amount = REGULAR_PRICE;
      amountEstimated = true;
    }
  }

  const currency =
    resource?.amount?.currency ?? resource?.amount?.currency_code ?? DEFAULT_CURRENCY;

  // 실패/환불 사유: PayPal webhook엔 표준 reason 필드가 없어 status_change_note 정도만 시도.
  // REFUNDED는 resource.reason(있을 때)도 본다(refund webhook에 담길 수 있음).
  const failureReason =
    internalEvent === 'PAYMENT_FAILED'
      ? (resource?.status_change_note ?? null)
      : internalEvent === 'REFUNDED'
        ? (resource?.reason ?? resource?.status_change_note ?? null)
        : null;

  return {
    payment_provider: PAYMENT_PROVIDER,
    plan_name: PLAN_NAME,
    amount,
    amount_estimated: amountEstimated,
    currency,
    billing_cycle: billingCycle,
    failure_reason: failureReason,
  };
}

/** 이벤트 resource에서 PayPal subscription id를 뽑는다(이벤트 종류에 따라 위치가 다름). */
function extractSubscriptionId(resource: PayPalWebhookEvent['resource']): string | null {
  if (!resource) return null;
  // BILLING.SUBSCRIPTION.* → resource.id가 subscription id.
  // PAYMENT.SALE.COMPLETED → resource.billing_agreement_id가 subscription id.
  return resource.billing_agreement_id ?? resource.id ?? null;
}

/** ACTIVATED 시 첫 결제는 trial cycle. plan 정보가 명확치 않으면 null로 두고 RPC 기본값에 맡긴다. */
function extractPlan(eventType: string): SubscriptionPlan | null {
  // 첫 활성화는 trial($1), 이후 갱신은 regular($4.9). 갱신(RENEWED) 시 RPC가 'regular' 기본 적용.
  if (eventType === 'BILLING.SUBSCRIPTION.ACTIVATED') return 'trial';
  return null;
}

type ApplyEventFn = (
  paypalSubscriptionId: string,
  event: SubscriptionEvent,
  opts?: { nextBillingAt?: string | null; plan?: SubscriptionPlan | null },
) => Promise<ApplyEventResult>;

const EVENT_MAP: Record<string, SubscriptionEvent> = {
  'BILLING.SUBSCRIPTION.ACTIVATED': 'ACTIVATED',
  'PAYMENT.SALE.COMPLETED': 'RENEWED',
  'BILLING.SUBSCRIPTION.PAYMENT.FAILED': 'PAYMENT_FAILED',
  'BILLING.SUBSCRIPTION.CANCELLED': 'CANCELED',
  'BILLING.SUBSCRIPTION.EXPIRED': 'CANCELED',
  // 환불: 구버전(SALE)/v2(CAPTURE) 둘 다 수신할 수 있어 모두 매핑.
  'PAYMENT.SALE.REFUNDED': 'REFUNDED',
  'PAYMENT.CAPTURE.REFUNDED': 'REFUNDED',
};

/**
 * Webhook 이벤트를 처리한다. 매핑되지 않는 이벤트는 무시(no-op)한다.
 * @param applyEvent  subscription.service.applySubscriptionEvent (DI로 받아 테스트 용이).
 */
export async function handleWebhookEvent(
  rawEvent: unknown,
  applyEvent: ApplyEventFn,
): Promise<void> {
  const event = (rawEvent ?? {}) as PayPalWebhookEvent;
  const eventType = event.event_type ?? '';
  const internalEvent = EVENT_MAP[eventType];

  if (!internalEvent) {
    logger.info(`PayPal webhook 무시 — event_type=${eventType}`);
    return;
  }

  const subId = extractSubscriptionId(event.resource);
  if (!subId) {
    logger.warn(`PayPal webhook subscription id 누락 — event_type=${eventType}`);
    return;
  }

  const nextBillingAt = event.resource?.billing_info?.next_billing_time ?? null;
  const plan = extractPlan(eventType);

  const result = await applyEvent(subId, internalEvent, { nextBillingAt, plan });

  if (!result.ok) {
    // subscription_not_found는 우리 DB에 아직 attach 안 된 구독(생성 직후 race) 가능 → 경고만.
    logger.warn(
      `구독 이벤트 적용 실패 — event=${internalEvent}, subId=${subId}, reason=${result.reason}`,
    );
    return;
  }

  logger.info(
    `구독 이벤트 적용 OK — event=${internalEvent}, subId=${subId}, userId=${result.userId}, tier=${result.tier}`,
  );

  // 애널리틱스 적재 — 결제 본 로직 성공 후 fire-and-forget(요청서 §3.2).
  // logAnalyticsEvent는 throw하지 않으므로 await해도 webhook 처리를 막지 않는다.
  const analyticsName = ANALYTICS_EVENT_NAME[internalEvent];
  if (analyticsName) {
    // 시트 스펙 결제 키(요청서 §2.1) + 기존 디버깅 키. source는 logAnalyticsEvent가 주입.
    const meta = extractPaymentMeta(eventType, internalEvent, event.resource);
    await logAnalyticsEvent({
      eventName: analyticsName,
      userId: result.userId,
      // 적용 후 tier가 분석축. ACTIVATED/RENEWED→premium, PAYMENT_FAILED/CANCELED→free.
      membershipStatus: result.tier,
      properties: {
        payment_provider: meta.payment_provider,
        plan_name: meta.plan_name,
        amount: meta.amount,
        amount_estimated: meta.amount_estimated, // 실측 아닌 plan 가격 추정 여부(프론트 회신 §1)
        currency: meta.currency,
        billing_cycle: meta.billing_cycle,
        failure_reason: meta.failure_reason,
        subscription_id: subId, // 유지(디버깅)
        paypal_event_type: eventType, // 유지(디버깅)
      },
    });
  }
}
