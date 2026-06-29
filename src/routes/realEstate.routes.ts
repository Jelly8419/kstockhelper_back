import { Router } from 'express';
import { logger } from '../utils/logger';
import { realEstateRequestRateLimiter } from '../middleware/rateLimit';
import { requestIp, lookupCountry } from '../services/geoRegion';
import {
  validateAndNormalize,
  insertRealEstateRequest,
} from '../services/realEstate.service';
import type { RealEstateRequestInput } from '../types';

export const realEstateRouter = Router();

/** 공통 응답 envelope — 기존 규약(subscription.routes.ts)과 동일. 정상 비즈니스 케이스는 HTTP 200 + code. */
type Envelope = { success: boolean; code: string; message: string; [k: string]: unknown };

/**
 * POST /api/real-estate/requests
 * 부동산 구매 지원 요청 폼 제출(리드 수집).
 *
 * 호출자: 프론트 BFF(Vercel). 브라우저가 직접 부르지 않는다.
 * userId/countryCode는 BFF가 서버 신뢰값으로 채워 전달한다.
 *
 * 흐름: rate limit(분당 5) → honeypot → 서버 재검증 → country_code 보정 → service_role insert.
 */
realEstateRouter.post('/requests', realEstateRequestRateLimiter, async (req, res) => {
  const body = (req.body ?? {}) as RealEstateRequestInput;

  // 1차 봇 방어(허니팟): 값이 채워져 있으면 봇 → 성공처럼 응답하되 적재하지 않는다.
  // (봇에게 실패 신호를 주지 않아 폼 구조 탐색을 막는다.)
  if (typeof body.honeypot === 'string' && body.honeypot.trim() !== '') {
    logger.warn(`real-estate honeypot 감지 — ip=${requestIp(req)} (적재 생략)`);
    return res.status(200).json({
      success: true,
      code: 'REAL_ESTATE_REQUEST_OK',
      message: '',
    } satisfies Envelope);
  }

  // 서버 재검증(클라 입력 신뢰 안 함).
  const result = validateAndNormalize(body);
  if (!result.ok) {
    logger.info(`real-estate 요청 검증 실패 — reason=${result.reason}, ip=${requestIp(req)}`);
    return res.status(200).json({
      success: false,
      code: 'REAL_ESTATE_REQUEST_INVALID',
      message: 'Some fields are invalid. Please check and try again.',
      reason: result.reason,
    } satisfies Envelope);
  }

  // country_code 보정 — BFF가 보낸 값을 우선 신뢰, 없으면 백엔드 geoip 폴백.
  // (BFF 경유라 소켓 IP는 Vercel일 수 있어 폴백 정확도는 낮다. subscription geo 신뢰 모델과 동일 취지.)
  const row = result.row;
  if (!row.country_code) {
    row.country_code = lookupCountry(requestIp(req));
  }

  try {
    const id = await insertRealEstateRequest(row);
    logger.info(
      `real-estate 요청 적재 OK — id=${id}, country=${row.country_code ?? 'unknown'}, user=${row.user_id ?? 'guest'}`,
    );
    return res.status(200).json({
      success: true,
      code: 'REAL_ESTATE_REQUEST_OK',
      message: '',
      id,
    } satisfies Envelope);
  } catch (err) {
    logger.error(
      'real-estate 요청 적재 실패:',
      err instanceof Error ? err.message : String(err),
    );
    return res.status(500).json({
      success: false,
      code: 'REAL_ESTATE_REQUEST_ERROR',
      message: 'An error occurred while submitting your request. Please try again.',
    } satisfies Envelope);
  }
});
