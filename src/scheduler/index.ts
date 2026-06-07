import cron from 'node-cron';
import { collectDartDisclosures } from '../collectors/dart.collector';
import { collectMarketData } from '../collectors/market.collector';
import { collectNaverNews } from '../collectors/naver.collector';
import { syncAffiliateUsers } from '../collectors/bybitAffiliate';
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

  // 주가/지수/환율: 장 마감 후 1일 1회 (16:00 KST)
  // 공공 API는 일별 종가 기준이라 장중 반복 조회가 의미 없다.
  cron.schedule('0 16 * * *', () => safeRun('MARKET', () => collectMarketData()), {
    timezone: 'Asia/Seoul',
  });

  // 네이버 뉴스 + Claude 파이프라인: 매 20분 (Claude 호출 비용 절감)
  cron.schedule('*/20 * * * *', () => safeRun('NAVER', () => collectNaverNews()), {
    timezone: 'Asia/Seoul',
  });

  // Bybit 레퍼럴 동기화: 매일 02:00 KST (연동 유저 재확인/유지)
  cron.schedule('0 2 * * *', () => safeRun('BYBIT', () => syncAffiliateUsers()), {
    timezone: 'Asia/Seoul',
  });

  logger.info('스케줄러 시작 — DART(1분) / MARKET(16:00) / NAVER(20분) / BYBIT(02:00)');

  // 콜드스타트: 기동 직후 1회 즉시 수집 (초기값 채우기)
  safeRun('DART', () => collectDartDisclosures());
  safeRun('MARKET', () => collectMarketData());
  safeRun('NAVER', () => collectNaverNews());
}
