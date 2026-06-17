/**
 * Price Gap Monitor — 1분 OHLC DB 입출력 (service_role).
 *
 * price_gap_ohlc 테이블에 1분봉을 upsert하고, 차트 조회를 제공한다.
 * saveMarketData(market.service.ts) 패턴을 따른다.
 */
import { supabase } from '../config/supabase';
import { logger } from '../utils/logger';
import type { GapExchange, GapOhlcRow, GapMinuteAvgRow, GapSnapshotRow } from '../types';

/**
 * 1분 OHLC 1행 저장. (timestamp_minute, stock_code, exchange) 충돌 시 갱신(멱등).
 * 서버 재시작 후 같은 분을 다시 flush해도 안전하다.
 */
export async function upsertOhlc(row: GapOhlcRow): Promise<void> {
  const { error } = await supabase
    .from('price_gap_ohlc')
    .upsert(row, { onConflict: 'timestamp_minute,stock_code,exchange' });

  if (error) {
    logger.error('price_gap_ohlc 저장 실패:', error.message);
    throw error;
  }
}

export interface ChartQuery {
  stockCode: string;
  exchange: GapExchange;
  /** ISO. 이 시각 이후 분봉만 (없으면 제한 없음) */
  fromIso?: string;
  /** ISO. 이 시각 이하 분봉만 (Basic 10분 지연 컷에 사용) */
  toIso?: string;
  /** 최대 행 수 (기본 600 = 10시간치 1분봉) */
  limit?: number;
}

/** 차트용 1분 OHLC 조회 — 시간 오름차순. price_gap_ohlc_lookup_idx 사용. */
export async function getOhlc(q: ChartQuery): Promise<GapOhlcRow[]> {
  let query = supabase
    .from('price_gap_ohlc')
    .select('timestamp_minute, stock_code, stock_name, exchange, open_gap, high_gap, low_gap, close_gap, avg_gap')
    .eq('stock_code', q.stockCode)
    .eq('exchange', q.exchange);

  if (q.fromIso) query = query.gte('timestamp_minute', q.fromIso);
  if (q.toIso) query = query.lte('timestamp_minute', q.toIso);

  query = query.order('timestamp_minute', { ascending: true }).limit(q.limit ?? 600);

  const { data, error } = await query;
  if (error) {
    logger.error('price_gap_ohlc 조회 실패:', error.message);
    throw error;
  }
  return (data ?? []) as GapOhlcRow[];
}

// ── price_gap_minute_avg (분당 평균 사전집계) ──────────────────────────────────

/**
 * 분당 평균 행 일괄 upsert. (stock_code, exchange, minute_of_day, period) 충돌 시 갱신.
 * minuteAvg 집계 모듈이 (종목×거래소)별로 호출한다.
 */
export async function upsertMinuteAvg(rows: GapMinuteAvgRow[]): Promise<void> {
  if (rows.length === 0) return;
  const { error } = await supabase
    .from('price_gap_minute_avg')
    .upsert(rows, { onConflict: 'stock_code,exchange,minute_of_day,period' });
  if (error) {
    logger.error('price_gap_minute_avg 저장 실패:', error.message);
    throw error;
  }
}

/**
 * 테이블 과거평균(period=0)용: (종목×거래소)별 minute_of_day → {avg, days} 맵.
 * /latest가 현재 KST 분으로 즉시 조회할 수 있게 전 종목·거래소를 한 번에 읽는다.
 */
export async function getPastAvgByMinute(): Promise<
  Map<string, { avg: number; days: number }>
> {
  const out = new Map<string, { avg: number; days: number }>();
  const PAGE = 1000;
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from('price_gap_minute_avg')
      .select('stock_code, exchange, minute_of_day, avg_close_gap, available_days')
      .eq('period', 0)
      .range(from, from + PAGE - 1);
    if (error) {
      logger.error('price_gap_minute_avg(period=0) 조회 실패:', error.message);
      throw error;
    }
    const rows = data ?? [];
    for (const r of rows) {
      // 키: exchange:stock_code:minute_of_day
      out.set(`${r.exchange}:${r.stock_code}:${r.minute_of_day}`, {
        avg: r.avg_close_gap as number,
        days: r.available_days as number,
      });
    }
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

/**
 * 차트 평균선(period=N)용: (종목×거래소×period)의 minute_of_day → {avg, days} 맵.
 */
export async function getAvgSeries(
  stockCode: string,
  exchange: GapExchange,
  period: number,
): Promise<Map<number, { avg: number; days: number }>> {
  const out = new Map<number, { avg: number; days: number }>();
  const { data, error } = await supabase
    .from('price_gap_minute_avg')
    .select('minute_of_day, avg_close_gap, available_days')
    .eq('stock_code', stockCode)
    .eq('exchange', exchange)
    .eq('period', period);
  if (error) {
    logger.error('price_gap_minute_avg(avgSeries) 조회 실패:', error.message);
    throw error;
  }
  for (const r of data ?? []) {
    out.set(r.minute_of_day as number, {
      avg: r.avg_close_gap as number,
      days: r.available_days as number,
    });
  }
  return out;
}

// ── 장 종료 스냅샷 DB 폴백 ─────────────────────────────────────────────────────

/**
 * 메모리 종료 스냅샷이 비었을 때(장 마감 후 재배포)의 폴백.
 * 당일(fromIso 이후) price_gap_ohlc에서 (종목×거래소)별 마지막 분봉을 모아 latest 행으로 만든다.
 *
 * 제약: OHLC 테이블은 gap(%)만 보관하고 krPrice/usdRef/exPrice 원시가격은 저장하지 않는다.
 * 따라서 gap만 close_gap으로 복원하고 가격 3개는 null로 둔다(프론트는 Gap 컬럼만 정상 표시).
 * 완전한 종료값 고정은 정상 운영(메모리 스냅샷) 경로에서 보장되고, 이건 재배포 예외의 차선책이다.
 *
 * @param fromIso 당일 세션 시작(09:00 KST = 00:00 UTC)의 ISO. 이 시각 이후 분봉만.
 */
export async function closingRowsFromOhlc(fromIso: string): Promise<GapSnapshotRow[]> {
  const { data, error } = await supabase
    .from('price_gap_ohlc')
    .select('timestamp_minute, stock_code, stock_name, exchange, close_gap')
    .gte('timestamp_minute', fromIso)
    .order('timestamp_minute', { ascending: true });
  if (error) {
    logger.error('price_gap_ohlc(closing 폴백) 조회 실패:', error.message);
    throw error;
  }

  // (종목:거래소)별 마지막(가장 늦은) 분봉만 남긴다. 오름차순이라 뒤에 온 게 최신 → 덮어쓰기.
  const latest = new Map<string, { close_gap: number; stockName: string; ts: number }>();
  for (const r of data ?? []) {
    const key = `${r.exchange}:${r.stock_code}`;
    latest.set(key, {
      close_gap: r.close_gap as number,
      stockName: r.stock_name as string,
      ts: new Date(r.timestamp_minute as string).getTime(),
    });
  }

  const rows: GapSnapshotRow[] = [];
  for (const [key, v] of latest) {
    const [exchange, stockCode] = key.split(':');
    rows.push({
      stockCode,
      stockName: v.stockName,
      exchange: exchange as GapExchange,
      krPrice: null, // OHLC 미보관 — 재배포 폴백에선 복원 불가
      usdRef: null,
      exPrice: null,
      gap: v.close_gap,
      ts: v.ts,
    });
  }
  return rows;
}
