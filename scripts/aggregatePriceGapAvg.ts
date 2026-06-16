/**
 * Price Gap 분당 평균 집계 수동 실행 스크립트.
 *
 * price_gap_ohlc → price_gap_minute_avg 사전집계 (period 0/3/5/10/20/30).
 * 백필 직후 1회 실행해 평균 테이블을 채운다. 이후엔 스케줄러(16:10 KST)가 자동 갱신.
 *
 * 사용법: npx tsx scripts/aggregatePriceGapAvg.ts
 * 선행: migrations/0010_price_gap_minute_avg.sql 적용 필요.
 */
import { aggregateMinuteAverages } from '../src/priceGap/minuteAvg';
import { logger } from '../src/utils/logger';

aggregateMinuteAverages()
  .then(() => {
    logger.info('[MinuteAvg] 수동 집계 완료');
    process.exit(0);
  })
  .catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[MinuteAvg] 수동 집계 실패: ${msg}`);
    process.exit(1);
  });
