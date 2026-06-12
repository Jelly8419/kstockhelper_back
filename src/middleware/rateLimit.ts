import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import type { Request, Response } from 'express';
import { logger } from '../utils/logger';

/**
 * Rate limiting 미들웨어.
 *
 * Railway 리버스 프록시 뒤에서 동작하므로 app.set('trust proxy', 1)이 선행돼야
 * req.ip가 X-Forwarded-For의 실제 클라이언트 IP로 해석된다(app.ts에서 설정).
 * trust proxy가 없으면 모든 요청이 프록시 IP 하나로 묶여 제한이 무력화된다.
 *
 * 키는 express-rate-limit의 ipKeyGenerator로 생성한다 — req.ip를 그대로 쓰면
 * IPv6에서 /64 정규화가 빠져 우회가 가능하므로 표준 헬퍼를 사용한다.
 */
function keyByIp(req: Request): string {
  return ipKeyGenerator(req.ip ?? 'unknown');
}

/**
 * 전역 일반 API 제한. IP당 1분에 120회.
 * 정상 사용(목록/번역 조회)에는 영향이 없고, 단일 IP의 폭주만 차단한다.
 */
export const apiRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: keyByIp,
  handler: (req: Request, res: Response) => {
    logger.warn(`API rate limit 초과 — ip=${req.ip}, path=${req.path}`);
    res.status(429).json({
      success: false,
      code: 'RATE_LIMITED',
      message: 'Too many requests. Please try again later.',
    });
  },
});

/**
 * 관리자 로그인 브루트포스 방어. IP당 15분에 10회.
 * 성공한 로그인은 카운트에서 제외(skipSuccessfulRequests)해 정상 사용자 영향 최소화.
 */
export const adminLoginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: keyByIp,
  handler: (req: Request, res: Response) => {
    logger.warn(`관리자 로그인 rate limit 초과 — ip=${req.ip}`);
    res.status(429).json({
      success: false,
      message: '로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.',
    });
  },
});
