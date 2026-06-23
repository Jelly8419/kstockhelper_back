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
 * Price Gap basic 폴링 제한 — 비회원(무인증) 공개 트래픽 대비.
 *
 * /price-gap/{latest,chart}는 인증 없이 tier=basic으로 열려 있어 공개 트래픽이 발생한다.
 * 전역 apiRateLimiter(120/min 통합) 위에 경로별 분리 한도를 둬, 한쪽 경로의 폭주가
 * 다른 경로 예산을 잠식하지 않게 한다. 프론트 폴링은 latest 12/min·chart 3/min(단일 탭)이라
 * 멀티탭·공유 IP 여유를 포함해 latest 60/min·chart 20/min으로 둔다.
 * premium 트래픽도 같은 IP 키로 묶이지만 한도가 충분히 커 정상 사용엔 영향 없다.
 */
function priceGapLimiter(limit: number, label: string) {
  return rateLimit({
    windowMs: 60 * 1000,
    limit,
    standardHeaders: 'draft-7', // 429에 RateLimit-* 및 Retry-After 포함
    legacyHeaders: false,
    keyGenerator: keyByIp,
    handler: (req: Request, res: Response) => {
      logger.warn(`price-gap ${label} rate limit 초과 — ip=${req.ip}`);
      res.status(429).json({
        success: false,
        code: 'RATE_LIMITED',
        message: 'Too many requests. Please try again later.',
      });
    },
  });
}

/** /price-gap/latest 전용 — IP당 분당 60회 (단일 탭 12회 기준 여유). */
export const priceGapLatestRateLimiter = priceGapLimiter(60, 'latest');

/** /price-gap/chart 전용 — IP당 분당 20회 (단일 탭 3회 기준 여유). */
export const priceGapChartRateLimiter = priceGapLimiter(20, 'chart');

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
