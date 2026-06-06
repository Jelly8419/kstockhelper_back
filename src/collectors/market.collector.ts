import { logger } from '../utils/logger';
import { saveMarketData } from '../services/market.service';
import { collectStockPrices } from './publicStock';
import { collectIndexPrices } from './publicIndex';
import { collectFxRates } from './bokFx';
import type { MarketDataUpsert } from '../types';

/**
 * 시장 데이터를 공공 API에서 수집해 market_data에 저장한다.
 * 소스:
 *   - 종목: 금융위원회 주식시세정보 (일별 종가)
 *   - 지수: 금융위원회 지수시세정보 (일별 종가)
 *   - 환율: 한국은행 ECOS (일별)
 *
 * 모두 "일별 종가" 기준이라 장중 실시간이 아니다.
 * 스케줄러가 장 마감 후 1일 1회(16:00 KST) 호출한다.
 *
 * @param _force 콜드스타트 호환용 파라미터. 공공 API는 일별 데이터라
 *   장시간 체크가 의미 없어 항상 수집한다. (인터페이스 유지)
 */
export async function collectMarketData(_force = false): Promise<void> {
  // 3개 소스를 병렬 수집 — 한 소스 실패가 전체를 막지 않게 allSettled
  const results = await Promise.allSettled([
    collectStockPrices(),
    collectIndexPrices(),
    collectFxRates(),
  ]);

  const rows: MarketDataUpsert[] = [];
  const labels = ['주식', '지수', '환율'];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      rows.push(...r.value);
    } else {
      const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
      logger.error(`market_data [${labels[i]}] 소스 실패:`, msg);
    }
  });

  if (rows.length === 0) {
    logger.warn('market_data 수집 결과 없음 — 갱신 생략 (마지막 값 유지)');
    return;
  }

  try {
    const saved = await saveMarketData(rows);
    logger.info(`market_data 갱신 완료 — ${saved}개 심볼 (주식/지수/환율 공공 API)`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('market_data 저장 실패:', msg);
  }
}
