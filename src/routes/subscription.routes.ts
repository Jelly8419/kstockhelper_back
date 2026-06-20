import { Router, raw } from 'express';
import { logger } from '../utils/logger';
import { decideRegion } from '../services/geoRegion';
import {
  createSubscription as paypalCreate,
  cancelSubscription as paypalCancel,
} from '../services/paypal.service';
import {
  getUserSubscription,
  attachPaypalSubscriptionId,
  markCanceling,
  applySubscriptionEvent,
} from '../services/subscription.service';
import { handleWebhookEvent } from '../services/subscriptionWebhook.service';
import { verifyWebhookSignature } from '../services/paypal.service';

export const subscriptionRouter = Router();

/** 공통 응답 envelope — 요청서 §2 규약: 정상 비즈니스 케이스는 HTTP 200 + code로 분기. */
type Envelope = { success: boolean; code: string; message: string; [k: string]: unknown };

/**
 * POST /api/subscription/create
 * 요청: { userId: string }
 * 제한국가 재검증 → PayPal 구독 생성 → approvalUrl 반환.
 */
subscriptionRouter.post('/create', async (req, res) => {
  const { userId } = req.body ?? {};
  if (typeof userId !== 'string' || !userId.trim()) {
    return res.status(400).json({
      success: false,
      code: 'SUBSCRIPTION_CREATE_ERROR',
      message: 'userId is required.',
    } satisfies Envelope);
  }

  try {
    // 1) 지역 재검증 — 제한국가만 구독 허용(요청서 §5).
    const region = decideRegion(req);
    if (!region.restrictedForSubscription) {
      logger.info(
        `구독 생성 거부(허용국가) — userId=${userId}, country=${region.country}, ip=${region.ip}`,
      );
      return res.status(200).json({
        success: false,
        code: 'SUBSCRIPTION_REGION_BLOCKED',
        message: 'Subscription is not available in your region.',
      } satisfies Envelope);
    }

    // 2) 이미 활성/예약 구독이면 중복 생성 차단.
    const current = await getUserSubscription(userId);
    if (!current) {
      return res.status(200).json({
        success: false,
        code: 'SUBSCRIPTION_CREATE_ERROR',
        message: 'User not found.',
      } satisfies Envelope);
    }
    if (current.subscription_status === 'active' || current.subscription_status === 'canceling') {
      return res.status(200).json({
        success: false,
        code: 'SUBSCRIPTION_ALREADY_ACTIVE',
        message: 'You already have an active subscription.',
      } satisfies Envelope);
    }

    // 3) PayPal 구독 생성.
    const result = await paypalCreate(userId);
    if (!result.ok || !result.subscriptionId || !result.approvalUrl) {
      logger.error(`PayPal 구독 생성 실패 — userId=${userId}, err=${result.error}`);
      return res.status(200).json({
        success: false,
        code: 'SUBSCRIPTION_CREATE_ERROR',
        message: 'Failed to create subscription.',
      } satisfies Envelope);
    }

    // 4) subscription ID 기록(활성화 전). 활성화는 Webhook이 SSOT.
    await attachPaypalSubscriptionId(userId, result.subscriptionId);

    logger.info(
      `구독 생성 OK — userId=${userId}, subId=${result.subscriptionId}, country=${region.country}`,
    );
    return res.status(200).json({
      success: true,
      code: 'SUBSCRIPTION_CREATE_OK',
      message: '',
      approvalUrl: result.approvalUrl,
    } satisfies Envelope);
  } catch (err) {
    logger.error('구독 생성 처리 실패:', err instanceof Error ? err.message : String(err));
    return res.status(200).json({
      success: false,
      code: 'SUBSCRIPTION_CREATE_ERROR',
      message: 'An error occurred while creating the subscription.',
    } satisfies Envelope);
  }
});

/**
 * POST /api/subscription/cancel
 * 요청: { userId: string }
 * 기간말 해지 — PayPal 해지 + DB status='canceling'(tier=premium 유지).
 */
subscriptionRouter.post('/cancel', async (req, res) => {
  const { userId } = req.body ?? {};
  if (typeof userId !== 'string' || !userId.trim()) {
    return res.status(400).json({
      success: false,
      code: 'SUBSCRIPTION_CANCEL_ERROR',
      message: 'userId is required.',
    } satisfies Envelope);
  }

  try {
    const current = await getUserSubscription(userId);
    if (!current || !current.paypal_subscription_id || current.subscription_status !== 'active') {
      return res.status(200).json({
        success: false,
        code: 'SUBSCRIPTION_NOT_ACTIVE',
        message: 'No active subscription to cancel.',
      } satisfies Envelope);
    }

    const result = await paypalCancel(current.paypal_subscription_id);
    if (!result.ok) {
      logger.error(`PayPal 해지 실패 — userId=${userId}, err=${result.error}`);
      return res.status(200).json({
        success: false,
        code: 'SUBSCRIPTION_CANCEL_ERROR',
        message: 'Failed to cancel subscription.',
      } satisfies Envelope);
    }

    // 기간말 해지: tier는 유지, status만 canceling. 기간 종료 시 CANCELLED Webhook이 free 전환.
    await markCanceling(userId);

    logger.info(`구독 해지 예약 OK — userId=${userId}, subId=${current.paypal_subscription_id}`);
    return res.status(200).json({
      success: true,
      code: 'SUBSCRIPTION_CANCEL_OK',
      message: '',
    } satisfies Envelope);
  } catch (err) {
    logger.error('구독 해지 처리 실패:', err instanceof Error ? err.message : String(err));
    return res.status(200).json({
      success: false,
      code: 'SUBSCRIPTION_CANCEL_ERROR',
      message: 'An error occurred while canceling the subscription.',
    } satisfies Envelope);
  }
});

/**
 * GET /api/subscription/status?userId=...
 * (선택, 요청서 §2.3) 프론트는 기본적으로 Supabase users 컬럼을 직접 read하지만,
 * canonical 상태 엔드포인트가 필요할 때 사용.
 */
subscriptionRouter.get('/status', async (req, res) => {
  const userId = req.query.userId;
  if (typeof userId !== 'string' || !userId.trim()) {
    return res
      .status(400)
      .json({ success: false, code: 'SUBSCRIPTION_STATUS_ERROR', message: 'userId is required.' });
  }

  try {
    const row = await getUserSubscription(userId);
    if (!row) {
      return res
        .status(200)
        .json({ success: false, code: 'SUBSCRIPTION_STATUS_ERROR', message: 'User not found.' });
    }
    return res.status(200).json({
      success: true,
      status: row.subscription_status,
      plan: row.subscription_plan,
      nextBillingDate: row.subscription_next_billing_at,
      lastPaymentStatus: row.subscription_last_payment_status,
    });
  } catch (err) {
    logger.error('구독 상태 조회 실패:', err instanceof Error ? err.message : String(err));
    return res.status(200).json({
      success: false,
      code: 'SUBSCRIPTION_STATUS_ERROR',
      message: 'An error occurred.',
    });
  }
});

/**
 * POST /api/subscription/webhook
 * PayPal Webhook 수신 — 활성화/실패/해지의 SSOT.
 * 서명 검증을 위해 raw body가 필요하므로 이 라우트만 express.raw()를 사용한다.
 * (app.ts의 글로벌 express.json()보다 먼저 마운트되어야 한다.)
 */
subscriptionRouter.post('/webhook', raw({ type: '*/*' }), async (req, res) => {
  const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';

  try {
    const valid = await verifyWebhookSignature(req.headers, rawBody);
    if (!valid) {
      logger.warn('PayPal webhook 서명 검증 실패 — 무시');
      // 200으로 응답해 PayPal 재시도 폭주를 막되, 처리는 하지 않는다.
      return res.status(200).json({ received: true });
    }

    const event = JSON.parse(rawBody);
    await handleWebhookEvent(event, applySubscriptionEvent);

    return res.status(200).json({ received: true });
  } catch (err) {
    logger.error('PayPal webhook 처리 실패:', err instanceof Error ? err.message : String(err));
    // PayPal은 non-2xx면 재시도한다. 일시 오류면 재시도가 도움 → 500.
    return res.status(500).json({ received: false });
  }
});
