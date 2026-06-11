import express from 'express';
import cors from 'cors';
import type { CorsOptions } from 'cors';
import { env } from './config/env';
import { logger } from './utils/logger';
import { bybitRouter } from './routes/bybit.routes';
import { binanceRouter } from './routes/binance.routes';
import { adminRouter } from './routes/admin.routes';
import { newsRouter } from './routes/news.routes';

export function createApp() {
  const app = express();

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
    methods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  };

  app.use(cors(corsOptions));
  app.options('*', cors(corsOptions)); // preflight 명시 처리

  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
  });

  app.use('/api/bybit', bybitRouter);
  app.use('/api/binance', binanceRouter);
  app.use('/api/news', newsRouter);
  app.use('/internal/admin', adminRouter);

  return app;
}
