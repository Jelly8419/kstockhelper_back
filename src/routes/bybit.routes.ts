import { Router } from 'express';
import { findAffiliateUser } from '../collectors/bybitAffiliate';
import { upgradeToPremium, findUserByBybitUid } from '../services/users.service';
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

  // 입력 검증
  if (typeof bybitUid !== 'string' || !bybitUid.trim() || typeof userId !== 'string' || !userId.trim()) {
    return res.status(400).json({
      success: false,
      message: 'bybitUid와 userId는 필수입니다.',
    } satisfies BybitVerifyResponse);
  }

  try {
    // 이미 다른 유저에 연결된 UID 차단 (중복 연동 방지)
    const existingOwner = await findUserByBybitUid(bybitUid);
    if (existingOwner && existingOwner !== userId) {
      return res.status(409).json({
        success: false,
        message: '이미 다른 계정에 연동된 Bybit UID입니다.',
      } satisfies BybitVerifyResponse);
    }

    // Bybit 레퍼럴 목록에서 UID 확인
    const affiliateUser = await findAffiliateUser(bybitUid);
    if (!affiliateUser) {
      return res.status(200).json({
        success: false,
        message: '우리 레퍼럴로 가입한 내역을 찾을 수 없습니다.',
      } satisfies BybitVerifyResponse);
    }

    // premium 승격
    const updated = await upgradeToPremium(userId, bybitUid);
    if (!updated) {
      return res.status(404).json({
        success: false,
        message: '해당 userId를 찾을 수 없습니다.',
      } satisfies BybitVerifyResponse);
    }

    logger.info(`Bybit verify 성공 — userId=${userId}, bybitUid=${bybitUid} → premium`);
    return res.status(200).json({
      success: true,
      message: 'Premium 승격이 완료되었습니다.',
    } satisfies BybitVerifyResponse);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Bybit verify 처리 실패:', msg);
    return res.status(500).json({
      success: false,
      message: '검증 처리 중 오류가 발생했습니다.',
    } satisfies BybitVerifyResponse);
  }
});
