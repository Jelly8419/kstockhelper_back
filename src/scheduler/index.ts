import cron from 'node-cron';
import { collectDartDisclosures } from '../collectors/dart.collector';
import { collectMarketData, collectFxData } from '../collectors/market.collector';
import { collectNaverNews } from '../collectors/naver.collector';
import { syncAffiliateUsers } from '../collectors/bybitAffiliate';
import { env } from '../config/env';
import { logger } from '../utils/logger';

/** 잡 실행을 try/catch로 감싸 한 주기 실패가 스케줄을 죽이지 않게 한다. */
function safeRun(name: string, fn: () => Promise<void>): void {
  fn().catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[${name}] 잡 실행 중 예외:`, msg);
  });
}

export function startScheduler(): void {
  // DART 공시: 매 1분 (Claude 번역 비용 발생 — ENABLE_DART로 제어)
  if (env.enableDart) {
    cron.schedule('* * * * *', () => safeRun('DART', () => collectDartDisclosures()), {
      timezone: 'Asia/Seoul',
    });
  } else {
    logger.warn('DART 수집 비활성화됨 (ENABLE_DART=false)');
  }

  // 주가/지수(KIS): 장 마감 후 1일 1회 (16:00 KST). API 비용 없음 — 항상 켬.
  cron.schedule('0 16 * * *', () => safeRun('MARKET', () => collectMarketData()), {
    timezone: 'Asia/Seoul',
  });

  // 환율(ER-API): 매일 1회 (09:10 KST). 등락은 직전 저장값 대비 → "전일 대비". 비용 없음.
  cron.schedule('10 9 * * *', () => safeRun('FX', () => collectFxData()), {
    timezone: 'Asia/Seoul',
  });

  // 네이버 뉴스 + Claude 파이프라인: 매 20분 (Claude 비용 발생 — ENABLE_NAVER로 제어)
  if (env.enableNaver) {
    cron.schedule('*/20 * * * *', () => safeRun('NAVER', () => collectNaverNews()), {
      timezone: 'Asia/Seoul',
    });
  } else {
    logger.warn('NAVER 수집 비활성화됨 (ENABLE_NAVER=false)');
  }

  // Bybit 레퍼럴 동기화: 매일 02:00 KST. verify 외엔 비용 거의 없음 — 항상 켬.
  cron.schedule('0 2 * * *', () => safeRun('BYBIT', () => syncAffiliateUsers()), {
    timezone: 'Asia/Seoul',
  });

  logger.info(
    `스케줄러 시작 — DART(${env.enableDart ? '1분' : 'off'}) / MARKET(16:00) / FX(09:10) / ` +
      `NAVER(${env.enableNaver ? '20분' : 'off'}) / BYBIT(02:00)`,
  );

  // 콜드스타트: 기동 직후 1회 즉시 수집 (초기값 채우기). 비활성 잡은 스킵.
  if (env.enableDart) safeRun('DART', () => collectDartDisclosures());
  safeRun('MARKET', () => collectMarketData());
  safeRun('FX', () => collectFxData());
  if (env.enableNaver) safeRun('NAVER', () => collectNaverNews());
}
