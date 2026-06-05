import { supabase } from '../config/supabase';
import { logger } from '../utils/logger';
import type { MarketDataUpsert } from '../types';

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
