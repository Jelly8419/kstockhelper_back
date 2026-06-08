import axios from 'axios';
import { KIS_BASE, kisHeaders } from '../config/kisAuth';
import { STOCKS } from '../constants/stocks';
import { logger } from '../utils/logger';
import { applyKisSign, toNum, sleep, withRetry, KIS_CALL_GAP_MS } from './publicCommon';
import type { MarketDataUpsert, KisStockPriceResponse } from '../types';

/** 국내주식 현재가 시세 [v1_국내주식-008] */
const STOCK_PRICE_PATH = '/uapi/domestic-stock/v1/quotations/inquire-price';
const TR_ID = 'FHKST01010100';

/**
 * 단일 종목의 현재가 정보를 한투 API로 조회한다.
 * fid_cond_mrkt_div_code=J (주식/ETF/ETN), fid_input_iscd=6자리 종목코드.
 */
async function fetchStock(code: string): Promise<KisStockPriceResponse['output'] | null> {
  const headers = await kisHeaders(TR_ID);
  const { data } = await axios.get<KisStockPriceResponse>(`${KIS_BASE}${STOCK_PRICE_PATH}`, {
    headers,
    params: {
      fid_cond_mrkt_div_code: 'J',
      fid_input_iscd: code,
    },
    timeout: 10_000,
  });

  if (data.rt_cd !== '0') {
    throw new Error(`KIS 주식시세 오류 (${data.rt_cd}): ${data.msg1}`);
  }
  return data.output ?? null;
}

/** 전 종목 현재가를 MarketDataUpsert[]로 수집 (한 종목 실패 격리) */
export async function collectStockPrices(): Promise<MarketDataUpsert[]> {
  const rows: MarketDataUpsert[] = [];

  let first = true;
  for (const stock of STOCKS) {
    // 한투 유량제한 회피: 두 번째 호출부터 간격을 둔다.
    if (!first) await sleep(KIS_CALL_GAP_MS);
    first = false;
    try {
      // 유량제한(EGW00201)은 일시적 → 재시도로 해소
      const out = await withRetry(() => fetchStock(stock.code));
      if (!out) {
        logger.warn(`주식 시세 없음 [${stock.name}]`);
        continue;
      }
      rows.push({
        symbol: stock.yahooSymbol, // 기존 키 유지 (005930.KS)
        name: stock.name,
        type: 'stock',
        price: toNum(out.stck_prpr),
        change: applyKisSign(toNum(out.prdy_vrss), out.prdy_vrss_sign),
        change_percent: toNum(out.prdy_ctrt),
        updated_at: new Date().toISOString(), // 현재가 기준 — 조회 시각 사용
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`주식 시세 수집 실패 [${stock.name}]:`, msg);
    }
  }

  return rows;
}
