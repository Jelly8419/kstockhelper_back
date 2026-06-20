// PayPal Subscriptions REST 클라이언트 (SDK 미사용, fetch 직호출 — 기존 Bybit/KIS 패턴과 일관).
//
// 다루는 PayPal REST 엔드포인트:
//  - POST /v1/oauth2/token                                  OAuth access token (client_credentials)
//  - POST /v1/billing/subscriptions                         구독 생성 (approval link 반환)
//  - POST /v1/billing/subscriptions/{id}/cancel             구독 해지(기간말)
//  - GET  /v1/billing/subscriptions/{id}                    구독 상태 조회
//  - POST /v1/notifications/verify-webhook-signature        Webhook 서명 검증
//
// Plan(Trial $1/1달 + Regular $4.9/월)은 사전 생성된 PAYPAL_PLAN_ID를 사용한다(scripts로 1회 생성).

import { env } from '../config/env';
import { logger } from '../utils/logger';

const BASE_URL =
  env.paypalMode === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';

// PayPal 응답(Record<string,unknown>)에서 타입 안전하게 값을 꺼내는 작은 헬퍼들.
function asStr(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
function asObj(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined;
}
function asArr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

// ── OAuth access token 캐시 ──────────────────────────────────────────────────
let cachedToken: { value: string; expiresAt: number } | null = null;

/** client_credentials로 access token을 발급/캐시한다. 만료 60초 전 갱신. */
async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 60_000) {
    return cachedToken.value;
  }

  const basic = Buffer.from(`${env.paypalClientId}:${env.paypalClientSecret}`).toString('base64');
  const res = await fetch(`${BASE_URL}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`PayPal OAuth 실패 — status=${res.status} body=${text.slice(0, 300)}`);
  }

  const json = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = {
    value: json.access_token,
    expiresAt: now + json.expires_in * 1000,
  };
  return cachedToken.value;
  // 주: 이 호출은 paypalFetch가 아니라 직접 fetch라 access_token 타입을 좁힐 필요 없음.
}

/** PayPal REST 공통 호출. 인증 토큰 주입 + JSON 처리. */
async function paypalFetch(
  path: string,
  init: { method: string; body?: unknown; headers?: Record<string, string> },
): Promise<{ status: number; json: Record<string, unknown> | null; text: string }> {
  const token = await getAccessToken();
  const res = await fetch(`${BASE_URL}${path}`, {
    method: init.method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...init.headers,
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return { status: res.status, json, text };
}

// ── 구독 생성 ────────────────────────────────────────────────────────────────
export interface CreateSubscriptionResult {
  ok: boolean;
  /** PayPal subscription ID (예: I-XXXX). ok=true일 때 존재. */
  subscriptionId?: string;
  /** 유저가 결제를 승인할 approval URL. ok=true일 때 존재. */
  approvalUrl?: string;
  /** 실패 시 진단용. */
  error?: string;
}

/**
 * 구독을 생성하고 approval URL을 반환한다.
 * @param userId  내부 유저 식별자 — custom_id로 PayPal에 함께 저장(Webhook에서 보조 확인용).
 */
export async function createSubscription(userId: string): Promise<CreateSubscriptionResult> {
  try {
    const { status, json, text } = await paypalFetch('/v1/billing/subscriptions', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: {
        plan_id: env.paypalPlanId,
        custom_id: userId,
        application_context: {
          brand_name: 'K-Stock Helper',
          user_action: 'SUBSCRIBE_NOW',
          shipping_preference: 'NO_SHIPPING',
          // PayPal 계정 없이 카드/체크카드 결제도 노출(요구사항 §9.3). 실제 노출은 계정/국가 정책에 따름.
          payment_method: { payer_selected: 'PAYPAL', payee_preferred: 'UNRESTRICTED' },
          return_url: env.subscriptionReturnUrl,
          cancel_url: env.subscriptionCancelUrl,
        },
      },
    });

    const subscriptionId = asStr(json?.id);
    if (status < 200 || status >= 300 || !subscriptionId) {
      return { ok: false, error: `status=${status} body=${text.slice(0, 300)}` };
    }

    const approvalUrl = asStr(
      asObj(asArr(json?.links).find((l) => asObj(l)?.rel === 'approve'))?.href,
    );

    if (!approvalUrl) {
      return { ok: false, error: 'approve link 누락', subscriptionId };
    }

    return { ok: true, subscriptionId, approvalUrl };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── 구독 해지(기간말) ────────────────────────────────────────────────────────
export interface CancelSubscriptionResult {
  ok: boolean;
  error?: string;
}

/**
 * 구독을 해지한다(기간말 — 이미 결제된 기간은 유지). PayPal은 즉시 status=CANCELLED로
 * 바꾸지만 결제 기간 종료까지는 우리 DB에서 status='canceling'(tier=premium)으로 유지하고,
 * 기간 종료 시 오는 CANCELLED Webhook으로 free 전환한다.
 */
export async function cancelSubscription(
  subscriptionId: string,
  reason = 'User requested cancellation',
): Promise<CancelSubscriptionResult> {
  try {
    const { status, text } = await paypalFetch(
      `/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`,
      { method: 'POST', body: { reason } },
    );
    // 성공은 204 No Content. 422(이미 해지/비활성)도 멱등적으로 성공 취급할 수 있으나,
    // 호출부에서 상태를 판단하도록 status만 검사한다.
    if (status === 204) return { ok: true };
    return { ok: false, error: `status=${status} body=${text.slice(0, 300)}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── 구독 상태 조회 ───────────────────────────────────────────────────────────
export interface SubscriptionDetail {
  id: string;
  status: string; // APPROVAL_PENDING | ACTIVE | SUSPENDED | CANCELLED | EXPIRED
  customId?: string;
  nextBillingTime?: string;
}

/** PayPal에서 구독 단건을 조회한다(서버 검증/폴백용). 실패 시 null. */
export async function getSubscription(subscriptionId: string): Promise<SubscriptionDetail | null> {
  try {
    const { status, json } = await paypalFetch(
      `/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}`,
      { method: 'GET' },
    );
    const id = asStr(json?.id);
    if (status < 200 || status >= 300 || !id) return null;
    return {
      id,
      status: asStr(json?.status) ?? '',
      customId: asStr(json?.custom_id),
      nextBillingTime: asStr(asObj(json?.billing_info)?.next_billing_time),
    };
  } catch (err) {
    logger.warn(`PayPal getSubscription 실패 — id=${subscriptionId} err=${String(err)}`);
    return null;
  }
}

// ── Webhook 서명 검증 ────────────────────────────────────────────────────────
/**
 * PayPal Webhook 서명을 검증한다. PayPal의 verify-webhook-signature 엔드포인트에
 * 수신 헤더 + 원문 body(JSON 파싱본)를 전달해 SUCCESS/FAILURE를 받는다.
 *
 * @param headers  수신 요청의 헤더(express req.headers, 소문자 키).
 * @param rawBody  수신 요청의 원문 body 문자열(파싱 전). transmission 서명 대상이라 원문 필요.
 */
export async function verifyWebhookSignature(
  headers: Record<string, string | string[] | undefined>,
  rawBody: string,
): Promise<boolean> {
  const h = (name: string): string => {
    const v = headers[name.toLowerCase()];
    return (Array.isArray(v) ? v[0] : v) ?? '';
  };

  let webhookEvent: unknown;
  try {
    webhookEvent = JSON.parse(rawBody);
  } catch {
    return false;
  }

  try {
    const { status, json } = await paypalFetch('/v1/notifications/verify-webhook-signature', {
      method: 'POST',
      body: {
        auth_algo: h('paypal-auth-algo'),
        cert_url: h('paypal-cert-url'),
        transmission_id: h('paypal-transmission-id'),
        transmission_sig: h('paypal-transmission-sig'),
        transmission_time: h('paypal-transmission-time'),
        webhook_id: env.paypalWebhookId,
        webhook_event: webhookEvent,
      },
    });
    if (status < 200 || status >= 300) {
      logger.warn(`PayPal webhook 검증 호출 실패 — status=${status}`);
      return false;
    }
    return json?.verification_status === 'SUCCESS';
  } catch (err) {
    logger.warn(`PayPal webhook 검증 예외 — ${String(err)}`);
    return false;
  }
}
