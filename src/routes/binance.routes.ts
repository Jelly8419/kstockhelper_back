import { Router } from 'express';
import { connectBinanceUid, findUserByBinanceUid } from '../services/users.service';
import { logger } from '../utils/logger';
import type { BinanceConnectResponse } from '../types';

export const binanceRouter = Router();

/**
 * POST /api/binance/connect
 * 요청: { binanceUid: string, userId: string }
 * Binance UID를 저장하고 상태를 pending(승인 대기)으로 변경한다.
 * Bybit와 달리 외부 API 자동 검증이 없고, 승인은 관리자가 Supabase 대시보드에서 수동 처리.
 * (approved → tier=premium 전환은 DB 트리거가 담당)
 */
binanceRouter.post('/connect', async (req, res) => {
  const { binanceUid, userId } = req.body ?? {};

  // 입력 검증
  if (
    typeof binanceUid !== 'string' ||
    !binanceUid.trim() ||
    typeof userId !== 'string' ||
    !userId.trim()
  ) {
    return res.status(400).json({
      success: false,
      message: 'binanceUid와 userId는 필수입니다.',
    } satisfies BinanceConnectResponse);
  }

  try {
    // 이미 다른 유저에 연결된 UID 차단 (중복 연동 방지)
    const existingOwner = await findUserByBinanceUid(binanceUid);
    if (existingOwner && existingOwner !== userId) {
      return res.status(409).json({
        success: false,
        message: '이미 다른 계정에 연동된 Binance UID입니다.',
      } satisfies BinanceConnectResponse);
    }

    // UID 저장 + 상태 pending
    const updated = await connectBinanceUid(userId, binanceUid);
    if (!updated) {
      return res.status(404).json({
        success: false,
        message: '해당 userId를 찾을 수 없습니다.',
      } satisfies BinanceConnectResponse);
    }

    logger.info(`Binance connect — userId=${userId}, binanceUid=${binanceUid} → pending`);
    return res.status(200).json({
      success: true,
      message: '신청이 접수되었습니다. 관리자 승인 후 Premium이 적용됩니다.',
    } satisfies BinanceConnectResponse);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Binance connect 처리 실패:', msg);
    return res.status(500).json({
      success: false,
      message: '신청 처리 중 오류가 발생했습니다.',
    } satisfies BinanceConnectResponse);
  }
});
