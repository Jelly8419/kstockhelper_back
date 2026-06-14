import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import type { CorsOptions } from 'cors';
import { env } from './config/env';
import { logger } from './utils/logger';
import { apiRateLimiter } from './middleware/rateLimit';
import { internalGuard } from './middleware/internalGuard';
import { bybitRouter } from './routes/bybit.routes';
import { binanceRouter } from './routes/binance.routes';
import { adminRouter } from './routes/admin.routes';
import { newsRouter } from './routes/news.routes';
import { priceGapRouter } from './routes/priceGap.routes';
import { featureFlagsRouter } from './routes/featureFlags.routes';

export function createApp() {
  const app = express();

  // Railway 리버스 프록시 뒤에서 동작 → 첫 번째 프록시(X-Forwarded-For 마지막 hop)를
  // 신뢰해 req.ip를 실제 클라이언트 IP로 해석한다. rate limit/IP 로깅의 전제.
  // 'true'가 아닌 1로 두어 임의 헤더 스푸핑으로 신뢰 체인이 늘어나지 않게 한다.
  app.set('trust proxy', 1);

  // 보안 응답 헤더 (X-Content-Type-Options, X-Frame-Options 등). API 서버라 CSP는 기본 비활성.
  app.use(helmet());

  // 프론트엔드(FRONTEND_URL)에서의 호출만 허용.
  // 거부된 origin은 로그에 남겨 운영에서 원인 파악이 가능하게 한다.
  const corsOptions: CorsOptions = {
    origin(origin, callback) {
      // origin 없음 = 서버-서버/curl/동일출처 → 허용
      if (!origin || origin === env.frontendUrl) {
        return callback(null, true);
      }
      logger.warn(`CORS 거부 — origin=${origin} (허용=${env.frontendUrl})`);
      return callback(null, false);
    },
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  };

  app.use(cors(corsOptions));
  app.options('*', cors(corsOptions)); // preflight 명시 처리

  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
  });

  // 일반 공개 API — IP당 요청 제한 (헬스체크/내부는 제외)
  app.use('/api', apiRateLimiter);
  app.use('/api/bybit', bybitRouter);
  app.use('/api/binance', binanceRouter);
  app.use('/api/news', newsRouter);
  app.use('/api/price-gap', priceGapRouter);
  app.use('/api/feature-flags', featureFlagsRouter);

  // 내부 관리자 API — 공유 시크릿 헤더 게이트 통과 후에만 라우터 진입
  app.use('/internal/admin', internalGuard, adminRouter);

  // 전역 에러 핸들러 — 라우트가 못 잡은 예외를 흡수. 상세(stack/메시지)는 로그에만,
  // 클라이언트에는 일반 메시지만 반환해 내부 구조 노출을 막는다.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const msg = err instanceof Error ? err.stack ?? err.message : String(err);
    logger.error('처리되지 않은 요청 오류:', msg);
    if (res.headersSent) return;
    res.status(500).json({
      success: false,
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred.',
    });
  });

  return app;
}
