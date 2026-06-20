// PayPal Webhook 이벤트 → 내부 구독 이벤트 매핑 (활성화의 SSOT).
// 서명 검증은 라우트에서 끝낸 뒤 이 핸들러가 event_type을 보고 apply_subscription_event RPC를 호출한다.
//
// 매핑(요청서 §3):
//  BILLING.SUBSCRIPTION.ACTIVATED        → ACTIVATED      (tier=premium, status=active)
//  PAYMENT.SALE.COMPLETED                → RENEWED        (next_billing 갱신, 결제 성공)
//  BILLING.SUBSCRIPTION.PAYMENT.FAILED   → PAYMENT_FAILED (즉시 free, status=past_due)
//  BILLING.SUBSCRIPTION.CANCELLED        → CANCELED       (기간 종료 도달, free)
//  BILLING.SUBSCRIPTION.EXPIRED          → CANCELED       (만료도 동일하게 free 처리)
//
// 그 외 이벤트(CREATED/UPDATED 등)는 무시한다.

import { logger } from '../utils/logger';
import type {
  SubscriptionEvent,
  SubscriptionPlan,
  ApplyEventResult,
} from './subscription.service';

interface PayPalWebhookEvent {
  event_type?: string;
  resource?: {
    id?: string; // subscription id (BILLING.SUBSCRIPTION.*) — I-XXXX
    billing_agreement_id?: string; // subscription id (PAYMENT.SALE.* 갱신 결제)
    custom_id?: string;
    plan_id?: string;
    billing_info?: { next_billing_time?: string };
    [k: string]: unknown;
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
}
