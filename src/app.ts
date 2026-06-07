import express from 'express';
import cors from 'cors';
import { env } from './config/env';
import { bybitRouter } from './routes/bybit.routes';

export function createApp() {
  const app = express();

  // 프론트엔드(kstockhelper.com)에서의 호출만 허용
  app.use(
    cors({
      origin: env.frontendUrl,
      methods: ['GET', 'POST'],
      allowedHeaders: ['Content-Type'],
    }),
  );

  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
  });

  app.use('/api/bybit', bybitRouter);

  return app;
}
