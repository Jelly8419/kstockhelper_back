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
import { getOhlc } from '../services/priceGap.service';
import { isPriceGapActive } from '../priceGap/holiday';
import { perpSymbolOf, EXCHANGES } from '../priceGap/symbols';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import type { GapExchange } from '../types';

export const priceGapRouter = Router();

/** 'premium'만 premium, 나머지(basic/비회원/누락)는 basic */
function isPremium(tier: unknown): boolean {
  return tier === 'premium';
}

// ── GET /latest ───────────────────────────────────────────────────────────────
priceGapRouter.get('/latest', (req, res) => {
  try {
    const premium = isPremium(req.query.tier);
    const now = Date.now();
    const marketOpen = isPriceGapActive() && isPriceGapRunning();

    let rows;
    let warmingUp = false;
    if (premium) {
      rows = snapshotLatest(now);
    } else {
      const delayed = snapshotDelayed(env.priceGapBasicDelayMs, now);
      rows = delayed.rows;
      warmingUp = delayed.warmingUp;
    }

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

  try {
    const premium = isPremium(req.query.tier);
    // Basic은 now-10분 이하 분봉만 노출(지연). Premium은 컷 없음.
    const toIso = premium ? undefined : new Date(Date.now() - env.priceGapBasicDelayMs).toISOString();

    const candles = await getOhlc({ stockCode: stock, exchange, toIso });

    return res.status(200).json({
      success: true,
      code: 'PRICE_GAP_CHART',
      data: {
        tier: premium ? 'premium' : 'basic',
        exchange,
        stock,
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
