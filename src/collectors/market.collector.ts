import { logger } from '../utils/logger';
import { saveMarketData } from '../services/market.service';
import { collectStockPrices } from './kisStock';
import { collectIndexPrices } from './kisIndex';
import { collectFxRates } from './exchangeRate';
import { isMarketOpen } from './publicCommon';
import type { MarketDataUpsert } from '../types';

/**
 * 시장 데이터(주가/지수/환율)를 수집해 market_data에 저장한다.
 *   - 종목: KIS 국내주식 현재가 (실시간)
 *   - 지수: KIS 국내업종 현재지수 (실시간)
 *   - 환율: ExchangeRate-API USD/KRW (값만, 등락 미노출)
 *
 * 스케줄러가 평일 장중(09:01~15:41 KST) 5분마다 호출한다. 장중에만 갱신하고,
 * 장 종료 후·주말·공휴일에는 수집을 스킵해 DB의 마지막 값을 그대로 고정한다.
 *
 * @param force true면 시간창(장중) 검사를 건너뛰고 즉시 수집한다.
 *   콜드스타트(서버 기동 직후 초기값 채우기)에서 사용.
 */
export async function collectMarketData(force = false): Promise<void> {
  // 장중 시간창 가드: 평일 09:01~15:41 KST 밖이면 스킵(마지막 값 고정).
  // force=true(콜드스타트)는 초기값을 채워야 하므로 검사 생략.
  if (!force && !isMarketOpen()) {
    return;
  }

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
  // 환율(ER-API)은 다른 서버라 한투 유량제한과 무관.
  try {
    rows.push(...(await collectFxRates()));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('market_data [환율] 소스 실패:', msg);
  }

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
