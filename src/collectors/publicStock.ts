import axios from 'axios';
import { env } from '../config/env';
import { STOCKS } from '../constants/stocks';
import { logger } from '../utils/logger';
import { recentRange, toNum, ymdToIso } from './publicCommon';
import type { MarketDataUpsert, PublicDataResponse, PublicMarketItem } from '../types';

const STOCK_URL =
  'http://apis.data.go.kr/1160100/service/GetStockSecuritiesInfoService/getStockPriceInfo';

/** 응답 item 배열 안전 추출 */
function extractItems<T>(res: PublicDataResponse<T>): T[] {
  const body = res.response?.body;
  if (!body || body.items === '' || !body.items?.item) return [];
  return body.items.item;
}

/**
 * 단일 종목의 최신 종가 정보를 조회한다.
 * 최근 기간을 조회한 뒤 basDt가 가장 최신인 1건을 사용 (주말/공휴일 대응).
 */
async function fetchStock(code: string): Promise<PublicMarketItem | null> {
  const { begin, end } = recentRange();
  const { data } = await axios.get<PublicDataResponse<PublicMarketItem>>(STOCK_URL, {
    params: {
      serviceKey: env.publicDataApiKey,
      resultType: 'json',
      numOfRows: 30,
      pageNo: 1,
      likeSrtnCd: code,
      beginBasDt: begin,
      endBasDt: end,
    },
    timeout: 10_000,
  });

  const items = extractItems(data);
  if (items.length === 0) return null;

  // basDt 내림차순 정렬 후 최신 1건
  items.sort((a, b) => (a.basDt < b.basDt ? 1 : -1));
  return items[0];
}

/** 전 종목 시세를 MarketDataUpsert[]로 수집 (한 종목 실패 격리) */
export async function collectStockPrices(): Promise<MarketDataUpsert[]> {
  const rows: MarketDataUpsert[] = [];

  for (const stock of STOCKS) {
    try {
      const item = await fetchStock(stock.code);
      if (!item) {
        logger.warn(`주식 시세 없음 [${stock.name}]`);
        continue;
      }
      rows.push({
        symbol: stock.yahooSymbol, // 기존 키 유지 (005930.KS)
        name: stock.name,
        type: 'stock',
        price: toNum(item.clpr),
        change: toNum(item.vs),
        change_percent: toNum(item.fltRt),
        updated_at: ymdToIso(item.basDt),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`주식 시세 수집 실패 [${stock.name}]:`, msg);
    }
  }

  return rows;
}
