import { supabase } from '../config/supabase';
import { logger } from '../utils/logger';
import type { MarketDataUpsert } from '../types';

/**
 * 특정 symbol의 현재 저장된 price를 조회한다.
 * upsert로 덮어쓰기 전에 호출하면 "직전(전일) 값"을 얻을 수 있다 — 환율 등락률 계산용.
 * 행이 없거나 조회 실패 시 null (첫 수집 등).
 */
export async function getStoredPrice(symbol: string): Promise<number | null> {
  const { data, error } = await supabase
    .from('market_data')
    .select('price')
    .eq('symbol', symbol)
    .maybeSingle();

  if (error) {
    logger.warn(`market_data 직전값 조회 실패 [${symbol}]:`, error.message);
    return null;
  }
  const price = data?.price;
  return typeof price === 'number' && Number.isFinite(price) ? price : null;
}

/**
 * market_data 테이블에 upsert.
 * symbol을 기준으로 종목/지수당 1행을 유지하며 최신값으로 갱신한다.
 */
export async function saveMarketData(items: MarketDataUpsert[]): Promise<number> {
  if (items.length === 0) return 0;

  const { data, error } = await supabase
    .from('market_data')
    .upsert(items, { onConflict: 'symbol' })
    .select('symbol');

  if (error) {
    logger.error('market_data 저장 실패:', error.message);
    throw error;
  }

  return data?.length ?? 0;
}
