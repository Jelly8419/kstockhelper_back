import cron from 'node-cron';
import { collectDartDisclosures } from '../collectors/dart.collector';
import { collectMarketData } from '../collectors/market.collector';
import { collectNaverNews } from '../collectors/naver.collector';
import { syncAffiliateUsers } from '../collectors/bybitAffiliate';
import { publishDueScheduled } from '../services/hotNews.service';
import { startPriceGap, stopPriceGap } from '../priceGap/lifecycle';
import { refreshHolidayCache, isPriceGapActive } from '../priceGap/holiday';
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

  // 주가/지수/환율: 매 5분 실행하되, 평일 장중(09:01~15:41 KST)에만 실제 수집.
  // 시간창 밖은 collectMarketData 내부에서 스킵 → 마지막 값 고정. API 비용 없음 — 항상 켬.
  cron.schedule('*/5 * * * *', () => safeRun('MARKET', () => collectMarketData()), {
    timezone: 'Asia/Seoul',
  });

  // 장 마감 확정값 갱신: 평일 16:00 KST 1회. 장중 마지막 틱(15:40)은 종가가 아닌
  // 장중값일 수 있어 종가/지수와 어긋난다. 정규장 종료(15:30) 후 한투가 종가를 확정한
  // 뒤 force=true로 시간창을 무시하고 한 번 더 수집해 종가로 덮어쓴다.
  cron.schedule('0 16 * * 1-5', () => safeRun('MARKET-CLOSE', () => collectMarketData(true)), {
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

  // 핫뉴스 예약 게시: 매 1분. due된 scheduled의 published_at을 보강한다.
  // 노출 자체는 hot_news_public 뷰가 (scheduled AND scheduled_at<=now())로 보장하므로
  // 이 잡은 게시일 정합성만 맞춘다. due 건이 없으면 가벼운 쿼리 1회 — 비용 무시 가능.
  // due 판정은 DB now()(UTC) 기준이라 timezone과 무관하다.
  cron.schedule('* * * * *', () => safeRun('HOT_NEWS', () => publishDueScheduled().then(() => {})), {
    timezone: 'Asia/Seoul',
  });

  // Price Gap Monitor: 장 시작(09:00)에 수집 start, 마감 여유(15:40)에 stop.
  // 평일만. start/stop은 동기(멱등)라 try/catch로 직접 감싼다.
  if (env.enablePriceGap) {
    const safeSync = (name: string, fn: () => void) => {
      try {
        fn();
      } catch (err) {
        logger.error(`[${name}] 잡 실행 중 예외:`, err instanceof Error ? err.message : String(err));
      }
    };
    cron.schedule('0 9 * * 1-5', () => safeSync('PRICE_GAP', startPriceGap), { timezone: 'Asia/Seoul' });
    cron.schedule('40 15 * * 1-5', () => safeSync('PRICE_GAP', stopPriceGap), { timezone: 'Asia/Seoul' });
    // 개장일 캐시 갱신: 매일 08:30 KST 1회 (장 시작 전). KIS 권고 "1일 1회 호출" 준수.
    // 휴장(공휴일)이면 09:00 start가 떠도 marketOpen=false로 정확히 표시된다.
    cron.schedule('30 8 * * *', () => safeRun('HOLIDAY', () => refreshHolidayCache()), {
      timezone: 'Asia/Seoul',
    });
    logger.warn('Price Gap 수집 비활성화됨 (ENABLE_PRICE_GAP=false)');
  }

  logger.info(
    `스케줄러 시작 — DART(${env.enableDart ? '1분' : 'off'}) / MARKET(장중 5분 + 마감 16:00) / ` +
      `NAVER(${env.enableNaver ? '20분' : 'off'}) / BYBIT(02:00) / HOT_NEWS(1분) / ` +
      `PRICE_GAP(${env.enablePriceGap ? '09:00~15:40' : 'off'})`,
  );

  // 콜드스타트: 기동 직후 1회 즉시 수집 (초기값 채우기). 비활성 잡은 스킵.
  // MARKET은 force=true로 시간창 무시하고 초기값을 채운다.
  if (env.enableDart) safeRun('DART', () => collectDartDisclosures());
  safeRun('MARKET', () => collectMarketData(true));
  if (env.enableNaver) safeRun('NAVER', () => collectNaverNews());
  // 핫뉴스: 기동 직후 1회 — 다운타임 중 도달한 예약분의 게시일을 즉시 보강.
  safeRun('HOT_NEWS', () => publishDueScheduled().then(() => {}));

  // Price Gap: 기동 직후 개장일 캐시를 prime한 뒤, 장중(시각+개장일)이면 즉시 수집 시작.
  // (재배포 중 장중 복구) PRICE_GAP_FORCE_START=true면 장외/휴장에도 강제 시작(로컬 테스트용).
  if (env.enablePriceGap) {
    safeRun('HOLIDAY', () =>
      refreshHolidayCache().then(() => {
        const active = isPriceGapActive();
        if (active || env.priceGapForceStart) {
          if (env.priceGapForceStart && !active) {
            logger.warn('[PRICE_GAP] 장외/휴장이지만 강제 시작(PRICE_GAP_FORCE_START) — 로컬 테스트 모드');
          }
          startPriceGap();
        }
      }),
    );
  }
}
