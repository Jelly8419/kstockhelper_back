/**
 * Feature Flags — 공개 읽기 API.
 *
 *   GET /api/feature-flags
 *     인증 불필요. 프론트가 UI 노출 분기에 사용한다.
 *     응답: { success, code, data: { priceGapPublic, ... } }
 *
 * 짧은 Cache-Control로 폴링/재방문 부하를 줄인다(값은 자주 안 바뀜).
 * 조회 실패 시에도 service가 기본값(false)으로 폴백하므로 항상 200.
 */
import { Router } from 'express';
import { getAllFlags } from '../services/featureFlags.service';
import { logger } from '../utils/logger';

export const featureFlagsRouter = Router();

featureFlagsRouter.get('/', async (_req, res) => {
  try {
    const flags = await getAllFlags();
    res.set('Cache-Control', 'public, max-age=30');
    return res.status(200).json({
      success: true,
      code: 'FEATURE_FLAGS',
      data: flags,
    });
  } catch (err) {
    // getAllFlags가 내부 폴백을 하므로 여기 오기 어렵지만, 최후 방어로 미노출 기본값.
    logger.error('feature-flags 응답 실패:', err instanceof Error ? err.message : String(err));
    return res.status(200).json({
      success: true,
      code: 'FEATURE_FLAGS',
      data: { priceGapPublic: false },
    });
  }
});
