import cron from 'node-cron';
import { collectDartDisclosures } from '../collectors/dart.collector';
import { collectMarketData } from '../collectors/market.collector';
import { collectNaverNews } from '../collectors/naver.collector';
import { logger } from '../utils/logger';

/** 잡 실행을 try/catch로 감싸 한 주기 실패가 스케줄을 죽이지 않게 한다. */
function safeRun(name: string, fn: () => Promise<void>): void {
  fn().catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[${name}] 잡 실행 중 예외:`, msg);
  });
}

export function startScheduler(): void {
  // DART 공시: 매 1분
  cron.schedule('* * * * *', () => safeRun('DART', () => collectDartDisclosures()), {
    timezone: 'Asia/Seoul',
  });

  // 주가/지수: 매 5분 (잡 내부에서 장 운영시간 체크)
  cron.schedule('*/5 * * * *', () => safeRun('MARKET', () => collectMarketData()), {
    timezone: 'Asia/Seoul',
  });

  // 네이버 뉴스 + Claude 파이프라인: 매 10분 (Claude 호출 비용 절감)
  cron.schedule('*/10 * * * *', () => safeRun('NAVER', () => collectNaverNews()), {
    timezone: 'Asia/Seoul',
  });

  logger.info('스케줄러 시작 — DART(1분) / MARKET(5분) / NAVER(10분)');

  // 콜드스타트: 기동 직후 1회 즉시 수집
  // market_data는 장 운영시간과 무관하게 강제 수집(force=true)하여 초기값을 채운다.
  safeRun('DART', () => collectDartDisclosures());
  safeRun('MARKET', () => collectMarketData(true));
  safeRun('NAVER', () => collectNaverNews());
}
