import { env } from './config/env';
import { createApp } from './app';
import { startScheduler } from './scheduler';
import { logger } from './utils/logger';

function main(): void {
  const app = createApp();

  const server = app.listen(env.port, () => {
    logger.info(`서버 기동 — http://localhost:${env.port}`);
    startScheduler();
  });

  // Graceful shutdown
  const shutdown = (signal: string) => {
    logger.info(`${signal} 수신 — 종료 중...`);
    server.close(() => {
      logger.info('서버 종료 완료');
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
