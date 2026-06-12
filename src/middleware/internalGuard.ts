import type { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'crypto';
import { env } from '../config/env';
import { logger } from '../utils/logger';

/**
 * /internal/admin/* 전용 네트워크 게이트.
 *
 * 관리자 로그인 엔드포인트는 JWT 인증 이전이라 adminAuth로 보호되지 않는다.
 * 외부에서 /internal/* 경로를 직접 호출하지 못하도록, 프론트(서버 사이드)만 아는
 * 공유 시크릿을 x-internal-secret 헤더로 요구한다. 일치하지 않으면 404로 응답해
 * 경로의 존재 자체를 숨긴다.
 *
 * 시크릿은 길이가 노출되지 않도록 timingSafeEqual로 상수시간 비교한다.
 */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  // 길이가 다르면 timingSafeEqual이 throw하므로 먼저 길이를 0폭 비교로 흡수한다.
  if (bufA.length !== bufB.length) {
    // 동일 길이 더미 비교로 타이밍 차이를 줄이고 false 반환
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export function internalGuard(req: Request, res: Response, next: NextFunction): void {
  const provided = req.headers['x-internal-secret'];
  const secret = env.internalApiSecret;

  if (typeof provided !== 'string' || !safeEqual(provided, secret)) {
    logger.warn(`내부 시크릿 검증 실패 — path=${req.path}, ip=${req.ip}`);
    // 경로 노출 최소화를 위해 404
    res.status(404).json({ success: false, message: 'Not found.' });
    return;
  }

  next();
}
