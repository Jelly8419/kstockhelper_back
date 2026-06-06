import axios from 'axios';
import { env } from '../config/env';
import { FX_RATES } from '../constants/stocks';
import { logger } from '../utils/logger';
import { recentRange, toNum, ymdToIso } from './publicCommon';
import type { MarketDataUpsert, EcosResponse } from '../types';

const ECOS_BASE = 'https://ecos.bok.or.kr/api/StatisticSearch';

/**
 * ECOS StatisticSearch (경로 파라미터 방식):
 *   /{KEY}/json/kr/{start}/{end}/{statCode}/{cycle}/{beginDate}/{endDate}/{itemCode}
 * 최근 기간을 조회해 TIME(일자) 최신 1건의 환율값을 사용.
 * change/change_percent 는 결정에 따라 null 처리.
 */
async function fetchFx(statCode: string, itemCode: string): Promise<{ value: number; time: string } | null> {
  const { begin, end } = recentRange();
  const url = `${ECOS_BASE}/${env.bokApiKey}/json/kr/1/100/${statCode}/D/${begin}/${end}/${itemCode}`;

  const { data } = await axios.get<EcosResponse>(url, { timeout: 10_000 });

  if (data.RESULT) {
    throw new Error(`ECOS 오류 (${data.RESULT.CODE}): ${data.RESULT.MESSAGE}`);
  }
  const rows = data.StatisticSearch?.row ?? [];
  if (rows.length === 0) return null;

  // TIME 내림차순 정렬 후 최신 1건
  rows.sort((a, b) => (a.TIME < b.TIME ? 1 : -1));
  const latest = rows[0];
  const value = toNum(latest.DATA_VALUE);
  if (value === null) return null;

  return { value, time: latest.TIME };
}

/** 환율 시세를 MarketDataUpsert[]로 수집 */
export async function collectFxRates(): Promise<MarketDataUpsert[]> {
  const rows: MarketDataUpsert[] = [];

  for (const fx of FX_RATES) {
    try {
      const result = await fetchFx(fx.statCode, fx.itemCode);
      if (!result) {
        logger.warn(`환율 시세 없음 [${fx.name}]`);
        continue;
      }
      rows.push({
        symbol: fx.symbol, // 기존 키 유지 (KRW=X)
        name: fx.name,
        type: 'fx',
        price: result.value,
        change: null, // 결정: 환율 등락은 null 처리
        change_percent: null,
        updated_at: ymdToIso(result.time),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`환율 시세 수집 실패 [${fx.name}]:`, msg);
    }
  }

  return rows;
}
