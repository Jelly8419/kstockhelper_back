import { logger } from '../utils/logger';
import { saveMarketData } from '../services/market.service';
import { collectStockPrices } from './kisStock';
import { collectIndexPrices } from './kisIndex';
import { collectFxRates } from './exchangeRate';
import type { MarketDataUpsert } from '../types';

/**
 * 주가/지수 데이터를 한국투자증권(KIS) API에서 수집해 market_data에 저장한다.
 *   - 종목: KIS 국내주식 현재가 (실시간)
 *   - 지수: KIS 국내업종 현재지수 (실시간)
 *
 * 한투 현재가 기준(장중 실시간). 스케줄러가 장 마감 후 1일 1회(16:00 KST)
 * 호출하므로 사실상 마감가 근처 값이 저장된다. 환율은 별도 잡(collectFxData)에서 처리.
 *
 * @param _force 콜드스타트 호환용 파라미터. (인터페이스 유지)
 */
export async function collectMarketData(_force = false): Promise<void> {
  const rows: MarketDataUpsert[] = [];

  // 한투(주식·지수)는 같은 서버라 유량제한 회피 위해 순차 실행.
  // 한 소스 실패가 다른 소스를 막지 않게 각각 try/catch.
  try {
    rows.push(...(await collectStockPrices()));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('market_data [주식(KIS)] 소스 실패:', msg);
  }
  try {
    rows.push(...(await collectIndexPrices()));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('market_data [지수(KIS)] 소스 실패:', msg);
  }

  if (rows.length === 0) {
    logger.warn('market_data(주식/지수) 수집 결과 없음 — 갱신 생략 (마지막 값 유지)');
    return;
  }

  try {
    const saved = await saveMarketData(rows);
    logger.info(`market_data 갱신 완료 — ${saved}개 심볼 (주식/지수 KIS)`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('market_data 저장 실패:', msg);
  }
}

/**
 * 환율 데이터를 ExchangeRate-API에서 수집해 market_data에 저장한다.
 * 등락(change/change_percent)은 직전 저장값 대비로 계산된다(collectFxRates 내부).
 * 스케줄러가 1일 1회(09:10 KST) 호출 → "전일 대비"가 자연스럽게 성립.
 */
export async function collectFxData(): Promise<void> {
  let rows: MarketDataUpsert[];
  try {
    rows = await collectFxRates();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('market_data [환율] 소스 실패:', msg);
    return;
  }

  if (rows.length === 0) {
    logger.warn('market_data(환율) 수집 결과 없음 — 갱신 생략 (마지막 값 유지)');
    return;
  }

  try {
    const saved = await saveMarketData(rows);
    logger.info(`market_data 갱신 완료 — ${saved}개 심볼 (환율 ER-API)`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('market_data(환율) 저장 실패:', msg);
  }
}
