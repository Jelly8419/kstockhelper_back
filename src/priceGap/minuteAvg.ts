/**
 * Price Gap Monitor — 분당 평균 갭 사전집계 (price_gap_ohlc → price_gap_minute_avg).
 *
 * 차트 평균선(선택 period의 같은 분 평균)과 테이블 과거평균(전체 과거 같은 분 평균)은
 * 매 요청 실시간 집계하면 무겁다. 장 마감 후 1회 이 모듈로 (종목×거래소×분×기간)별
 * close_gap 평균을 계산해 price_gap_minute_avg에 적재하고, API는 그 테이블만 읽는다.
 *
 * period 정의:
 *   0  = 전체 과거(All)        — 테이블 Past Avg Gap용
 *   N  = 최근 N거래일 (3/5/10/20/30) — 차트 평균선용
 *
 * minute_of_day = KST 기준 hour*60+min (장중 540~935). price_gap_ohlc.timestamp_minute는
 * UTC라 집계 시 KST로 변환해 분 키를 만든다.
 *
 * 집계는 JS 메모리에서 수행한다(데이터 규모 ~2만행/소수 종목이라 충분). PostgREST로
 * 날짜 윈도우 GROUP BY를 표현하기 까다로운 점도 회피한다.
 */
import { supabase } from '../config/supabase';
import { upsertMinuteAvg } from '../services/priceGap.service';
import { GAP_STOCKS, EXCHANGES } from './symbols';
import { logger } from '../utils/logger';
import type { GapExchange, GapMinuteAvgRow } from '../types';

/** 집계 대상 period 집합. 0=All(테이블 과거평균), 나머지=차트 평균선. */
export const AVG_PERIODS: readonly number[] = [0, 3, 5, 10, 20, 30];

/** UTC timestamp(ISO) → KST minute_of_day (hour*60+min). KST=UTC+9 고정. */
function kstMinuteOfDay(iso: string): number {
  const kstMs = new Date(iso).getTime() + 9 * 3_600_000;
  const d = new Date(kstMs);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/** UTC timestamp(ISO) → KST 거래일 키 YYYYMMDD. period 윈도우(거래일 수)용. */
function kstDayKey(iso: string): string {
  const kstMs = new Date(iso).getTime() + 9 * 3_600_000;
  return new Date(kstMs).toISOString().slice(0, 10);
}

interface OhlcLite {
  timestamp_minute: string;
  close_gap: number;
}

/** 한 (종목×거래소)의 모든 close_gap 행을 페이징 없이 전부 읽는다(시간 오름차순). */
async function fetchAllClose(stockCode: string, exchange: GapExchange): Promise<OhlcLite[]> {
  const out: OhlcLite[] = [];
  const PAGE = 1000;
  let from = 0;
  // Supabase 기본 1000행 제한 → range로 페이징.
  for (;;) {
    const { data, error } = await supabase
      .from('price_gap_ohlc')
      .select('timestamp_minute, close_gap')
      .eq('stock_code', stockCode)
      .eq('exchange', exchange)
      .order('timestamp_minute', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as OhlcLite[];
    out.push(...rows);
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

/**
 * 한 (종목×거래소)에 대해 모든 period의 분당 평균 행을 계산한다.
 * 반환: price_gap_minute_avg upsert 행 배열.
 */
function aggregatePair(
  stockCode: string,
  exchange: GapExchange,
  rows: OhlcLite[],
): GapMinuteAvgRow[] {
  if (rows.length === 0) return [];

  // 1) 전체 거래일 목록(오름차순). period=N은 "가장 최근 N거래일"만 포함.
  const allDays = Array.from(new Set(rows.map((r) => kstDayKey(r.timestamp_minute)))).sort();

  const result: GapMinuteAvgRow[] = [];
  for (const period of AVG_PERIODS) {
    // period=0(All)이면 전체 거래일, 아니면 최근 N거래일
    const daySet =
      period === 0 ? new Set(allDays) : new Set(allDays.slice(Math.max(0, allDays.length - period)));

    // minute_of_day → { sum, count, days:Set } 누산
    const byMinute = new Map<number, { sum: number; count: number; days: Set<string> }>();
    for (const r of rows) {
      const day = kstDayKey(r.timestamp_minute);
      if (!daySet.has(day)) continue;
      const mod = kstMinuteOfDay(r.timestamp_minute);
      let acc = byMinute.get(mod);
      if (!acc) {
        acc = { sum: 0, count: 0, days: new Set() };
        byMinute.set(mod, acc);
      }
      acc.sum += r.close_gap;
      acc.count += 1;
      acc.days.add(day);
    }

    for (const [mod, acc] of byMinute) {
      result.push({
        stock_code: stockCode,
        exchange,
        minute_of_day: mod,
        period,
        avg_close_gap: acc.sum / acc.count,
        available_days: acc.days.size,
      });
    }
  }
  return result;
}

/**
 * 전체 (종목×거래소)에 대해 분당 평균을 집계해 price_gap_minute_avg에 적재한다.
 * 장 마감 후 cron 1회 + 콜드스타트에서 호출. 멱등(upsert)이라 재실행 안전.
 */
export async function aggregateMinuteAverages(): Promise<void> {
  let totalRows = 0;
  for (const stock of GAP_STOCKS) {
    for (const exchange of EXCHANGES) {
      try {
        const rows = await fetchAllClose(stock.code, exchange);
        const aggRows = aggregatePair(stock.code, exchange, rows);
        if (aggRows.length > 0) {
          await upsertMinuteAvg(aggRows);
          totalRows += aggRows.length;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`[MinuteAvg] 집계 실패 (${exchange}:${stock.code}): ${msg}`);
      }
    }
  }
  logger.info(`[MinuteAvg] 분당 평균 집계 완료 — ${totalRows}행 적재`);
}
