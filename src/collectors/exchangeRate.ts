import axios from 'axios';
import { FX_RATES } from '../constants/stocks';
import { logger } from '../utils/logger';
import type { MarketDataUpsert, ErApiResponse } from '../types';

/**
 * 환율 수집 — ExchangeRate-API open access 엔드포인트.
 * 키 불필요, 무료. base=USD 기준 rates 객체에서 대상 통화 값을 읽는다.
 *   GET https://open.er-api.com/v6/latest/USD
 *   → { result: "success", rates: { KRW: 1551.57, ... }, time_last_update_utc }
 *
 * 한투 API는 외환 현물 환율을 제공하지 않아 이 소스를 사용한다.
 */
const ER_API_URL = 'https://open.er-api.com/v6/latest/USD';

/** USD 기준 환율 응답을 1회 조회 (모든 통화가 한 응답에 포함됨) */
async function fetchUsdRates(): Promise<ErApiResponse> {
  const { data } = await axios.get<ErApiResponse>(ER_API_URL, { timeout: 10_000 });
  if (data.result !== 'success') {
    throw new Error(`ExchangeRate-API 오류: result=${data.result}`);
  }
  return data;
}

/** 환율 시세를 MarketDataUpsert[]로 수집 */
export async function collectFxRates(): Promise<MarketDataUpsert[]> {
  const rows: MarketDataUpsert[] = [];

  let res: ErApiResponse;
  try {
    res = await fetchUsdRates();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('환율 시세 수집 실패 (ExchangeRate-API):', msg);
    return rows;
  }

  // 갱신 시각: time_last_update_utc(RFC1123) → ISO. 실패 시 현재시각.
  const updatedAt = (() => {
    const t = Date.parse(res.time_last_update_utc ?? '');
    return Number.isNaN(t) ? new Date().toISOString() : new Date(t).toISOString();
  })();

  for (const fx of FX_RATES) {
    const value = res.rates?.[fx.currency];
    if (value === undefined || value === null || !Number.isFinite(value)) {
      logger.warn(`환율 시세 없음 [${fx.name}] (통화코드 ${fx.currency})`);
      continue;
    }
    rows.push({
      symbol: fx.symbol, // 기존 키 유지 (KRW=X)
      name: fx.name,
      type: 'fx',
      price: value,
      change: null, // 결정: 환율 등락은 null 처리 (소스가 전일대비 미제공)
      change_percent: null,
      updated_at: updatedAt,
    });
  }

  return rows;
}
