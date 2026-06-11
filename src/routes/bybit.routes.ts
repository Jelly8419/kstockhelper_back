import { Router } from 'express';
import { findAffiliateUser } from '../collectors/bybitAffiliate';
import { upgradeToPremium, findUserByBybitUid } from '../services/users.service';
import { appendActivityLog } from '../services/admin.service';
import { logger } from '../utils/logger';
import type { BybitVerifyResponse } from '../types';

export const bybitRouter = Router();

/**
 * POST /api/bybit/verify
 * 요청: { bybitUid: string, userId: string }
 * Bybit 레퍼럴 가입자면 해당 유저를 premium 승격 + bybit_uid 연결.
 */
bybitRouter.post('/verify', async (req, res) => {
  const { bybitUid, userId } = req.body ?? {};
  logger.info(`Bybit verify 요청 — userId=${userId}, bybitUid=${bybitUid}`);
  // 입력 검증
  if (typeof bybitUid !== 'string' || !bybitUid.trim() || typeof userId !== 'string' || !userId.trim()) {
    return res.status(400).json({
      success: false,
      code: 'BYBIT_UID_REQUIRED',
      message: 'bybitUid and userId are required.',
    } satisfies BybitVerifyResponse);
  }

  try {
    // 이미 다른 유저에 연결된 UID 차단 (중복 연동 방지)
    const existingOwner = await findUserByBybitUid(bybitUid);
    if (existingOwner && existingOwner !== userId) {
      return res.status(409).json({
        success: false,
        code: 'BYBIT_UID_ALREADY_LINKED',
        message: 'This Bybit UID is already linked to another account.',
      } satisfies BybitVerifyResponse);
    }

    // Bybit 레퍼럴 목록에서 UID 확인
    const affiliateUser = await findAffiliateUser(bybitUid);
    if (!affiliateUser) {
      return res.status(200).json({
        success: false,
        code: 'BYBIT_REFERRAL_NOT_FOUND',
        message: 'No signup found under our referral.',
      } satisfies BybitVerifyResponse);
    }

    // premium 승격
    const updated = await upgradeToPremium(userId, bybitUid);
    if (!updated) {
      return res.status(404).json({
        success: false,
        code: 'BYBIT_USER_NOT_FOUND',
        message: 'The specified userId was not found.',
      } satisfies BybitVerifyResponse);
    }

    // 활동 로그: UID 승인 + 프리미엄 자동 승인 (실패해도 승격 자체는 성공 처리)
    try {
      await appendActivityLog({
        user_id: userId,
        type: 'UID_APPROVED',
        exchange: 'BYBIT',
        uid: bybitUid,
      });
      await appendActivityLog({
        user_id: userId,
        type: 'PREMIUM_AUTO_APPROVED',
        exchange: 'BYBIT',
        uid: bybitUid,
        to_tier: 'premium',
      });
    } catch {
      logger.warn(`Bybit 활동 로그 기록 실패 — userId=${userId}`);
    }

    logger.info(`Bybit verify 성공 — userId=${userId}, bybitUid=${bybitUid} → premium`);
    return res.status(200).json({
      success: true,
      code: 'BYBIT_VERIFY_OK',
      message: 'Premium upgrade completed.',
    } satisfies BybitVerifyResponse);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Bybit verify 처리 실패:', msg);
    return res.status(500).json({
      success: false,
      code: 'BYBIT_VERIFY_ERROR',
      message: 'An error occurred during verification.',
    } satisfies BybitVerifyResponse);
  }
});
