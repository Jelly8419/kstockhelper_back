/**
 * Price Gap Monitor — 수집 생명주기 오케스트레이터.
 *
 * 4개 feed(KIS/Bybit/Binance/FX)를 start/stop하고, 1초 tick으로 갭을 계산해
 * OHLC worker에 흘린다. 스케줄러가 장 시작/마감에 start()/stop()을 호출한다.
 *
 *   start(): perp/KIS feed 기동 + 1초 tick 시작
 *   stop():  1초 tick 중지 + 진행 중 분봉 강제 flush + perp/KIS feed 중지 + store reset
 *
 * FX(USDT/KRW) feed는 장 생명주기와 무관하게 24h 독립 가동된다(app 부팅 시 1회 시작).
 * 업비트/빗썸은 24시간 거래되므로, 장 마감 후에도 환율 카드에 최신값을 채울 수 있다.
 * 따라서 start/stop은 FX feed를 건드리지 않고, store reset도 latestFx는 보존한다.
 *
 * 멱등: 이미 실행 중이면 start()는 무시. 중복 기동/타이머 누수를 막는다.
 */
import { startKisFeed, stopKisFeed } from './kisFeed';
import { startBybitFeed, stopBybitFeed } from './bybitFeed';
import { startBinanceFeed, stopBinanceFeed } from './binanceFeed';
import { onTick, flushAll, resetOhlc } from './ohlcWorker';
import { tick, reset as resetStore, captureClosingSnapshot } from './store';
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

  // 장 종료 시점 스냅샷 보존 — 마감 후에도 /latest가 마지막 행(가격/갭)을 고정 응답한다.
  // resetStore 전에 캡처해야 최신값이 살아 있다(문서 §2 값 유지 요구).
  captureClosingSnapshot();

  // 진행 중 분봉 보존 (정상 종료 한정 — 크래시엔 무력)
  flushAll();

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
