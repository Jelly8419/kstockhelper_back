/**
 * Price Gap Monitor — 수집 생명주기 오케스트레이터.
 *
 * 4개 feed(KIS/Bybit/Binance/FX)를 start/stop하고, 1초 tick으로 갭을 계산해
 * OHLC worker에 흘린다. 스케줄러가 장 시작/마감에 start()/stop()을 호출한다.
 *
 *   start(): feed 4종 기동 + 1초 tick 시작
 *   stop():  1초 tick 중지 + 진행 중 분봉 강제 flush + feed 4종 중지 + store reset
 *
 * 멱등: 이미 실행 중이면 start()는 무시. 중복 기동/타이머 누수를 막는다.
 */
import { startKisFeed, stopKisFeed } from './kisFeed';
import { startBybitFeed, stopBybitFeed } from './bybitFeed';
import { startBinanceFeed, stopBinanceFeed } from './binanceFeed';
import { startFxFeed, stopFxFeed } from './fxFeed';
import { onTick, flushAll, resetOhlc } from './ohlcWorker';
import { tick, reset as resetStore } from './store';
import { env } from '../config/env';
import { logger } from '../utils/logger';

let running = false;
let tickTimer: NodeJS.Timeout | null = null;

/** 1초 tick: 최신값으로 갭 계산 → buffer push(store 내부) + OHLC 누산 */
function runTick(): void {
  const ticks = tick();
  onTick(ticks);
}

/** 수집 시작 (멱등) */
export function startPriceGap(): void {
  if (running) return;
  running = true;

  startFxFeed();
  startKisFeed();
  startBybitFeed();
  startBinanceFeed();

  tickTimer = setInterval(runTick, env.priceGapTickMs);
  logger.info(`[PriceGap] 수집 시작 (tick ${env.priceGapTickMs}ms)`);
}

/** 수집 중지 — 진행 중 분봉 flush 후 정리 */
export function stopPriceGap(): void {
  if (!running) return;
  running = false;

  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }

  // 진행 중 분봉 보존 (정상 종료 한정 — 크래시엔 무력)
  flushAll();

  stopFxFeed();
  stopKisFeed();
  stopBybitFeed();
  stopBinanceFeed();

  resetOhlc();
  resetStore();
  logger.info('[PriceGap] 수집 중지');
}

/** 현재 수집 중인지 (라우트의 marketOpen 판정 보조) */
export function isPriceGapRunning(): boolean {
  return running;
}
