/**
 * Price Gap Monitor — 폴링 API.
 *
 *   GET /api/price-gap/latest?tier=premium|basic
 *     테이블용 최신 스냅샷. Premium=cache 최신, Basic=T-10분(warming-up이면 빈 rows).
 *   GET /api/price-gap/chart?exchange=binance|bybit&stock=005930&tier=premium|basic
 *     1분 OHLC 차트. Basic은 now-10분 이하 분봉만.
 *
 * tier는 프론트가 useAuth로 판정해 쿼리로 전달한다(백엔드는 유저 인증의 source가 아님).
 * 'premium'이 아닌 모든 값(basic/비회원/누락)은 basic으로 강등한다.
 * 제한국가 차단은 프론트(geo) 책임. 응답 포맷은 {success, code, data} (news.routes 일관).
 */
import { Router } from 'express';
import { snapshotLatest, snapshotDelayed, currentFx } from '../priceGap/store';
import { isPriceGapRunning } from '../priceGap/lifecycle';
import { getOhlc, getPastAvgByMinute, getAvgSeries } from '../services/priceGap.service';
import { isPriceGapActive } from '../priceGap/holiday';
import { perpSymbolOf, EXCHANGES } from '../priceGap/symbols';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import type { GapExchange, GapLatestRow, GapChartCandle } from '../types';

export const priceGapRouter = Router();

/** 'premium'만 premium, 나머지(basic/비회원/누락)는 basic */
function isPremium(tier: unknown): boolean {
  return tier === 'premium';
}

/** /chart period 기본값(프론트가 period 미지정 시) — 10거래일 평균선 */
const DEFAULT_PERIOD = 10;
/** 허용 period 집합 (0=All은 차트용으론 노출 안 함, 평균선은 N만) */
const ALLOWED_PERIODS = new Set([3, 5, 10, 20, 30]);

// ── 과거평균(period=0) 분 캐시 ─────────────────────────────────────────────────
// price_gap_minute_avg(period=0)은 하루 1회 집계로만 바뀐다. /latest 매 호출마다 DB를
// 치지 않도록 분 단위로 캐싱한다(키: exchange:stock:minuteOfDay → {avg,days}).
let pastAvgCache: Map<string, { avg: number; days: number }> | null = null;
let pastAvgCacheAt = 0;
const PAST_AVG_TTL_MS = 5 * 60_000; // 5분이면 충분(원본은 하루 1회 갱신)

async function pastAvgMap(): Promise<Map<string, { avg: number; days: number }>> {
  const now = Date.now();
  if (pastAvgCache && now - pastAvgCacheAt < PAST_AVG_TTL_MS) return pastAvgCache;
  pastAvgCache = await getPastAvgByMinute();
  pastAvgCacheAt = now;
  return pastAvgCache;
}

/** epoch ms → KST minute_of_day (hour*60+min). */
function kstMinuteOfDay(ms: number): number {
  const d = new Date(ms + 9 * 3_600_000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/**
 * 주어진 시각(now) 기준 "오늘(KST) 09:00"의 UTC ISO. /chart 당일 컷(§7.11)용.
 * KST=UTC+9 고정. now의 KST 날짜를 구해 그날 09:00 KST(=00:00 UTC)로 만든다.
 */
function todaySessionStartIso(nowMs: number): string {
  const kst = new Date(nowMs + 9 * 3_600_000);
  const y = kst.getUTCFullYear();
  const mo = kst.getUTCMonth();
  const d = kst.getUTCDate();
  // 09:00 KST = 00:00 UTC 당일
  return new Date(Date.UTC(y, mo, d, 0, 0, 0)).toISOString();
}

// ── GET /latest ───────────────────────────────────────────────────────────────
priceGapRouter.get('/latest', async (req, res) => {
  try {
    const premium = isPremium(req.query.tier);
    const now = Date.now();
    const marketOpen = isPriceGapActive() && isPriceGapRunning();

    let snapRows;
    let warmingUp = false;
    if (premium) {
      snapRows = snapshotLatest(now);
    } else {
      const delayed = snapshotDelayed(env.priceGapBasicDelayMs, now);
      snapRows = delayed.rows;
      warmingUp = delayed.warmingUp;
    }

    // 과거평균(period=0) 주입. 스냅샷 ts의 KST 분으로 매칭(Basic은 T-10분 분에 정렬됨).
    // 집계 테이블이 비어 있어도(아직 미집계) pastAvg=null로 안전하게 흘린다.
    let avgMap: Map<string, { avg: number; days: number }>;
    try {
      avgMap = await pastAvgMap();
    } catch (e) {
      logger.warn(`[price-gap/latest] 과거평균 조회 실패(null로 진행): ${e instanceof Error ? e.message : String(e)}`);
      avgMap = new Map();
    }

    const rows: GapLatestRow[] = snapRows.map((r) => {
      const mod = kstMinuteOfDay(r.ts);
      const hit = avgMap.get(`${r.exchange}:${r.stockCode}:${mod}`);
      const pastAvgGap = hit ? hit.avg : null;
      const gapVsPastAvg =
        r.gap !== null && pastAvgGap !== null ? r.gap - pastAvgGap : null;
      return { ...r, pastAvgGap, gapVsPastAvg };
    });

    const fx = currentFx(now);

    return res.status(200).json({
      success: true,
      code: 'PRICE_GAP_LATEST',
      data: {
        tier: premium ? 'premium' : 'basic',
        marketOpen,
        warmingUp,
        // USDT/KRW (한국 시장 USDT 원화가). 갭 분모이자 환율 카드 표시값.
        usdtKrw: fx ? { price: fx.price, stale: fx.stale } : null,
        serverTime: new Date(now).toISOString(),
        rows,
      },
    });
  } catch (err) {
    logger.error('price-gap/latest 실패:', err instanceof Error ? err.message : String(err));
    return res.status(500).json({
      success: false,
      code: 'PRICE_GAP_ERROR',
      message: 'An error occurred while loading price gap data.',
    });
  }
});

// ── GET /chart ────────────────────────────────────────────────────────────────
priceGapRouter.get('/chart', async (req, res) => {
  const exchange = String(req.query.exchange ?? '') as GapExchange;
  const stock = String(req.query.stock ?? '');

  if (!EXCHANGES.includes(exchange)) {
    return res.status(400).json({
      success: false,
      code: 'PRICE_GAP_INVALID_EXCHANGE',
      message: 'exchange must be binance or bybit.',
    });
  }
  if (!perpSymbolOf(stock)) {
    return res.status(400).json({
      success: false,
      code: 'PRICE_GAP_INVALID_STOCK',
      message: 'unknown stock code.',
    });
  }

  // period: 평균선 기준 거래일 수. 미지정/비허용이면 기본 10D.
  const periodRaw = Number(req.query.period);
  const period = ALLOWED_PERIODS.has(periodRaw) ? periodRaw : DEFAULT_PERIOD;

  try {
    const premium = isPremium(req.query.tier);
    const now = Date.now();
    // Basic은 now-10분 이하 분봉만 노출(지연). Premium은 컷 없음.
    const toIso = premium ? undefined : new Date(now - env.priceGapBasicDelayMs).toISOString();
    // 당일 캔들만(§7.11 X축 당일 기준): 오늘 09:00 KST 이후 분봉.
    const fromIso = todaySessionStartIso(now);

    // OHLC와 period 평균선을 병렬 조회.
    const [ohlc, avgSeries] = await Promise.all([
      getOhlc({ stockCode: stock, exchange, fromIso, toIso }),
      getAvgSeries(stock, exchange, period).catch((e) => {
        logger.warn(`[price-gap/chart] 평균선 조회 실패(null로 진행): ${e instanceof Error ? e.message : String(e)}`);
        return new Map<number, { avg: number; days: number }>();
      }),
    ]);

    const candles: GapChartCandle[] = ohlc.map((c) => {
      const mod = kstMinuteOfDay(new Date(c.timestamp_minute).getTime());
      const hit = avgSeries.get(mod);
      return {
        ...c,
        minuteOfDay: mod,
        avgGap: hit ? hit.avg : null,
        availableDays: hit ? hit.days : null,
      };
    });

    return res.status(200).json({
      success: true,
      code: 'PRICE_GAP_CHART',
      data: {
        tier: premium ? 'premium' : 'basic',
        exchange,
        stock,
        period,
        candles,
      },
    });
  } catch (err) {
    logger.error('price-gap/chart 실패:', err instanceof Error ? err.message : String(err));
    return res.status(500).json({
      success: false,
      code: 'PRICE_GAP_ERROR',
      message: 'An error occurred while loading chart data.',
    });
  }
});
