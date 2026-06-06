import axios from 'axios';
import { env } from '../config/env';
import { INDICES } from '../constants/stocks';
import { logger } from '../utils/logger';
import { recentRange, toNum, ymdToIso } from './publicCommon';
import type { MarketDataUpsert, PublicDataResponse, PublicMarketItem } from '../types';

const INDEX_URL =
  'http://apis.data.go.kr/1160100/service/GetMarketIndexInfoService/getStockMarketIndex';

function extractItems<T>(res: PublicDataResponse<T>): T[] {
  const body = res.response?.body;
  if (!body || body.items === '' || !body.items?.item) return [];
  return body.items.item;
}

/**
 * 단일 지수의 최신 종가 정보 조회.
 * idxNm("코스피"/"코스닥")로 조회하되, 응답에 유사 지수명이 섞일 수 있어
 * idxNm 정확 일치 + basDt 최신 1건을 선택한다.
 */
async function fetchIndex(idxNm: string): Promise<PublicMarketItem | null> {
  const { begin, end } = recentRange();
  const { data } = await axios.get<PublicDataResponse<PublicMarketItem>>(INDEX_URL, {
    params: {
      serviceKey: env.publicDataApiKey,
      resultType: 'json',
      numOfRows: 100,
      pageNo: 1,
      idxNm,
      beginBasDt: begin,
      endBasDt: end,
    },
    timeout: 10_000,
  });

  const items = extractItems(data).filter((it) => it.idxNm === idxNm);
  if (items.length === 0) return null;

  items.sort((a, b) => (a.basDt < b.basDt ? 1 : -1));
  return items[0];
}

/** 전 지수 시세를 MarketDataUpsert[]로 수집 */
export async function collectIndexPrices(): Promise<MarketDataUpsert[]> {
  const rows: MarketDataUpsert[] = [];

  for (const idx of INDICES) {
    try {
      const item = await fetchIndex(idx.idxNm);
      if (!item) {
        logger.warn(`지수 시세 없음 [${idx.name}]`);
        continue;
      }
      rows.push({
        symbol: idx.symbol, // 기존 키 유지 (^KS11)
        name: idx.name,
        type: 'index',
        price: toNum(item.clpr),
        change: toNum(item.vs),
        change_percent: toNum(item.fltRt),
        updated_at: ymdToIso(item.basDt),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`지수 시세 수집 실패 [${idx.name}]:`, msg);
    }
  }

  return rows;
}
