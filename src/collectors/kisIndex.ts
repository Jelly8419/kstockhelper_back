import axios from 'axios';
import { KIS_BASE, kisHeaders } from '../config/kisAuth';
import { INDICES } from '../constants/stocks';
import { logger } from '../utils/logger';
import { applyKisSign, toNum, sleep, withRetry, KIS_CALL_GAP_MS } from './publicCommon';
import type { MarketDataUpsert, KisIndexPriceResponse } from '../types';

/** 국내업종 현재지수 [v1_국내주식-063] */
const INDEX_PRICE_PATH = '/uapi/domestic-stock/v1/quotations/inquire-index-price';
const TR_ID = 'FHPUP02100000';

/**
 * 단일 업종지수의 현재가 정보를 한투 API로 조회한다.
 * fid_cond_mrkt_div_code=U (업종), fid_input_iscd=업종코드(코스피 0001 / 코스닥 1001).
 */
async function fetchIndex(iscd: string): Promise<KisIndexPriceResponse['output'] | null> {
  const headers = await kisHeaders(TR_ID);
  const { data } = await axios.get<KisIndexPriceResponse>(`${KIS_BASE}${INDEX_PRICE_PATH}`, {
    headers,
    params: {
      fid_cond_mrkt_div_code: 'U',
      fid_input_iscd: iscd,
    },
    timeout: 10_000,
  });

  if (data.rt_cd !== '0') {
    throw new Error(`KIS 지수시세 오류 (${data.rt_cd}): ${data.msg1}`);
  }
  return data.output ?? null;
}

/** 전 지수 현재가를 MarketDataUpsert[]로 수집 (한 지수 실패 격리) */
export async function collectIndexPrices(): Promise<MarketDataUpsert[]> {
  const rows: MarketDataUpsert[] = [];

  let first = true;
  for (const idx of INDICES) {
    // 한투 유량제한 회피: 두 번째 호출부터 간격을 둔다.
    if (!first) await sleep(KIS_CALL_GAP_MS);
    first = false;
    try {
      // 유량제한(EGW00201)은 일시적 → 재시도로 해소
      const out = await withRetry(() => fetchIndex(idx.kisCode));
      if (!out) {
        logger.warn(`지수 시세 없음 [${idx.name}]`);
        continue;
      }
      rows.push({
        symbol: idx.symbol, // 기존 키 유지 (^KS11)
        name: idx.name,
        type: 'index',
        price: toNum(out.bstp_nmix_prpr),
        change: applyKisSign(toNum(out.bstp_nmix_prdy_vrss), out.prdy_vrss_sign),
        change_percent: toNum(out.bstp_nmix_prdy_ctrt),
        updated_at: new Date().toISOString(), // 현재가 기준 — 조회 시각 사용
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`지수 시세 수집 실패 [${idx.name}]:`, msg);
    }
  }

  return rows;
}
