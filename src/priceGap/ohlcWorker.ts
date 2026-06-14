/**
 * Price Gap Monitor — 1분 OHLC 집계 worker.
 *
 * store.tick()이 1초마다 내놓는 GapTick[]을 받아 (종목×거래소)별로 현재 분(minute)에
 * 누산하고, 분 경계가 바뀌면 직전 분을 price_gap_ohlc로 flush한다.
 *
 *   open  = 해당 분 첫 gap
 *   high  = 최고 gap
 *   low   = 최저 gap
 *   close = 마지막 gap (차트 라인 기준)
 *   avg   = sum/count (저장만, 차트 미사용)
 *
 * gap이 null인 tick(소스 누락/stale)은 누산에서 제외한다(허위 분봉 방지).
 * 서버 재시작 시 진행 중 분봉은 인메모리라 소실 → 정상 종료(stop) 시 강제 flush로 보존.
 * upsert가 멱등이라 재시작 후 같은 분 재flush도 안전.
 */
import { upsertOhlc } from '../services/priceGap.service';
import { GAP_STOCKS } from './symbols';
import { logger } from '../utils/logger';
import type { GapExchange, GapTick } from '../types';

interface Accumulator {
  minuteKey: number; // floor(ts / 60000)
  stockCode: string;
  exchange: GapExchange;
  open: number;
  high: number;
  low: number;
  close: number;
  sum: number;
  count: number;
}

/** `${exchange}:${code}` → 진행 중 누산기 */
const acc = new Map<string, Accumulator>();

function key(exchange: GapExchange, code: string): string {
  return `${exchange}:${code}`;
}

function stockName(code: string): string {
  return GAP_STOCKS.find((s) => s.code === code)?.name ?? code;
}

/** 누산기 → DB 행 변환 후 저장 (fire-and-forget, 실패는 로깅만) */
function flush(a: Accumulator): void {
  const iso = new Date(a.minuteKey * 60_000).toISOString();
  upsertOhlc({
    timestamp_minute: iso,
    stock_code: a.stockCode,
    stock_name: stockName(a.stockCode),
    exchange: a.exchange,
    open_gap: a.open,
    high_gap: a.high,
    low_gap: a.low,
    close_gap: a.close,
    avg_gap: a.count > 0 ? a.sum / a.count : null,
  }).catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[OHLC] flush 실패 (${a.exchange}:${a.stockCode} @${iso}): ${msg}`);
  });
}

/**
 * 1초 tick 처리. store.tick()의 결과를 받아 분 경계 flush + 누산.
 * lifecycle의 1초 setInterval에서 호출한다.
 */
export function onTick(ticks: GapTick[]): void {
  for (const t of ticks) {
    if (t.gap === null) continue; // 계산 불가 tick은 분봉에 반영 안 함
    const k = key(t.exchange, t.stockCode);
    const minuteKey = Math.floor(t.ts / 60_000);
    const cur = acc.get(k);

    if (!cur || cur.minuteKey !== minuteKey) {
      // 분 경계 변경 → 직전 분 flush 후 새 분 시작
      if (cur) flush(cur);
      acc.set(k, {
        minuteKey,
        stockCode: t.stockCode,
        exchange: t.exchange,
        open: t.gap,
        high: t.gap,
        low: t.gap,
        close: t.gap,
        sum: t.gap,
        count: 1,
      });
      continue;
    }

    // 같은 분 누산
    cur.high = Math.max(cur.high, t.gap);
    cur.low = Math.min(cur.low, t.gap);
    cur.close = t.gap;
    cur.sum += t.gap;
    cur.count += 1;
  }
}

/** 정상 종료 시 진행 중 분봉 전부 flush (데이터 보존) */
export function flushAll(): void {
  for (const a of acc.values()) flush(a);
  acc.clear();
}

/** 상태 초기화 (테스트/재시작용) */
export function resetOhlc(): void {
  acc.clear();
}
