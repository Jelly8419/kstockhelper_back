import yahooFinance from 'yahoo-finance2';
import { STOCKS, INDICES } from '../constants/stocks';
import { isMarketOpen } from '../utils/marketHours';
import { logger } from '../utils/logger';
import { saveMarketData } from '../services/market.service';
import type { MarketDataUpsert, MarketType } from '../types';

// yahoo-finance2의 안내/설문/생존 메시지를 끈다 (로그 노이즈 제거)
yahooFinance.suppressNotices(['yahooSurvey']);

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 2_000;

interface SymbolMeta {
  symbol: string;
  name: string;
  type: MarketType;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 429(Too Many Requests) 등 일시적 오류로 판단되는지 */
function isTransient(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /Too Many Requests|429|ETIMEDOUT|ECONNRESET|fetch failed/i.test(msg);
}

/**
 * Yahoo quote 호출 + 지수 backoff 재시도.
 * 일시 오류(429 등)면 2s → 4s → 6s 간격으로 최대 3회 재시도한다.
 */
async function fetchQuotesWithRetry(symbols: string[]) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await yahooFinance.quote(symbols);
    } catch (err) {
      if (attempt < MAX_RETRIES && isTransient(err)) {
        const waitMs = RETRY_BASE_MS * attempt;
        logger.warn(
          `Yahoo 일시 오류 (시도 ${attempt}/${MAX_RETRIES}) — ${waitMs}ms 후 재시도`,
        );
        await sleep(waitMs);
        continue;
      }
      throw err;
    }
  }
  // 도달 불가 (루프에서 return 또는 throw) — 타입 만족용
  throw new Error('Yahoo quote 재시도 로직 오류');
}

/** 수집 대상 = 종목(stock) + 지수/환율(index|fx) */
function targets(): SymbolMeta[] {
  const stocks: SymbolMeta[] = STOCKS.map((s) => ({
    symbol: s.yahooSymbol,
    name: s.name,
    type: 'stock',
  }));
  const indices: SymbolMeta[] = INDICES.map((i) => ({
    symbol: i.yahooSymbol,
    name: i.name,
    type: i.type,
  }));
  return [...stocks, ...indices];
}

/**
 * 주가/지수 데이터를 수집해 market_data에 저장한다.
 * 장 운영시간(평일 09:00~15:35 KST)이 아니면 갱신하지 않는다.
 * → 장 종료 후에는 DB의 마지막 값이 그대로 고정 유지된다.
 *
 * @param force true면 장 운영시간 체크를 무시하고 강제로 수집/upsert 한다.
 *   (콜드스타트 1회 초기값 채우기 용도)
 */
export async function collectMarketData(force = false): Promise<void> {
  if (!force && !isMarketOpen()) {
    logger.info('장 운영시간 아님 — market_data 갱신 생략 (마지막 값 유지)');
    return;
  }
  if (force && !isMarketOpen()) {
    logger.info('콜드스타트 강제 수집 — 장 운영시간 체크 무시');
  }

  const metas = targets();
  const symbols = metas.map((m) => m.symbol);

  try {
    const quotes = await fetchQuotesWithRetry(symbols);
    const quoteList = Array.isArray(quotes) ? quotes : [quotes];

    const bySymbol = new Map(quoteList.map((q) => [q.symbol, q]));
    const now = new Date().toISOString();

    const rows: MarketDataUpsert[] = metas.map((meta) => {
      const q = bySymbol.get(meta.symbol);
      return {
        symbol: meta.symbol,
        name: meta.name,
        type: meta.type,
        price: q?.regularMarketPrice ?? null,
        change: q?.regularMarketChange ?? null,
        change_percent: q?.regularMarketChangePercent ?? null,
        updated_at: now,
      };
    });

    const saved = await saveMarketData(rows);
    logger.info(`market_data 갱신 완료 — ${saved}개 심볼`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('market_data 수집 실패:', msg);
  }
}
