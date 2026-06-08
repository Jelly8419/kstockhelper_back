import { logger } from '../utils/logger';
import { saveMarketData } from '../services/market.service';
import { collectStockPrices } from './kisStock';
import { collectIndexPrices } from './kisIndex';
import { collectFxRates } from './exchangeRate';
import type { MarketDataUpsert } from '../types';

/**
 * 시장 데이터를 외부 API에서 수집해 market_data에 저장한다.
 * 소스:
 *   - 종목: 한국투자증권(KIS) 국내주식 현재가 (실시간)
 *   - 지수: 한국투자증권(KIS) 국내업종 현재지수 (실시간)
 *   - 환율: ExchangeRate-API (USD 기준 latest)
 *
 * 주가/지수는 한투 현재가 기준(장중 실시간). 스케줄러가 장 마감 후
 * 1일 1회(16:00 KST) 호출하므로 사실상 마감가 근처 값이 저장된다.
 *
 * @param _force 콜드스타트 호환용 파라미터. (인터페이스 유지)
 */
export async function collectMarketData(_force = false): Promise<void> {
  // 한투(주식·지수)는 같은 서버라 유량제한 회피 위해 순차 실행.
  // 환율(다른 서버)은 한투와 병렬로 묶는다. 한 소스 실패가 전체를 막지 않게 allSettled.
  const collectKis = async (): Promise<MarketDataUpsert[]> => {
    const stocks = await collectStockPrices();
    const indices = await collectIndexPrices();
    return [...stocks, ...indices];
  };

  const results = await Promise.allSettled([collectKis(), collectFxRates()]);

  const rows: MarketDataUpsert[] = [];
  const labels = ['주식/지수(KIS)', '환율'];
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
    logger.info(`market_data 갱신 완료 — ${saved}개 심볼 (주식/지수 KIS, 환율 ER-API)`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('market_data 저장 실패:', msg);
  }
}
