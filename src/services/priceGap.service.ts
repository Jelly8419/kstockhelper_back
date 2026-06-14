/**
 * Price Gap Monitor — 1분 OHLC DB 입출력 (service_role).
 *
 * price_gap_ohlc 테이블에 1분봉을 upsert하고, 차트 조회를 제공한다.
 * saveMarketData(market.service.ts) 패턴을 따른다.
 */
import { supabase } from '../config/supabase';
import { logger } from '../utils/logger';
import type { GapExchange, GapOhlcRow } from '../types';

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
