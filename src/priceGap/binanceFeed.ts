/**
 * Price Gap Monitor — Binance 수집기 (WS 우선, REST 자동 폴백).
 *
 * PoC에서 한국 IP는 Binance WS 데이터 평면이 차단됨을 확인했다(open은 되나 프레임 0).
 * 해외 배포 리전에선 WS가 정상일 공산이 크므로 WS를 먼저 시도하되,
 * **probe 시간 내 프레임이 0건이면 REST 폴링으로 자동 전환**한다. REST는 한국에서도 됨.
 * 폴백 중에도 주기적으로 WS를 재시도해 해외 재배포 시 자동으로 WS로 복귀한다.
 *
 *   WS:   wss://fstream.binance.com/stream?streams=<sym>@aggTrade/...
 *   REST: GET fapi/v1/ticker/price (symbol 미지정 전체 1콜 → 우리 심볼만 추출)
 *
 * 가격을 store.updateExPrice('binance', code, price)로 전달.
 */
import WebSocket from 'ws';
import axios from 'axios';
import { updateExPrice } from './store';
import { GAP_PERP_SYMBOLS, CODE_BY_PERP_SYMBOL } from './symbols';
import { env } from '../config/env';
import { logger } from '../utils/logger';

const BINANCE_WS_URL = 'wss://fstream.binance.com/stream';
const BINANCE_REST_PRICE = 'https://fapi.binance.com/fapi/v1/ticker/price';
/** WS 차단 환경에서 폴백 후 WS 재시도 주기 */
const WS_RETRY_MS = 60_000;
const MAX_BACKOFF_MS = 30_000;

type Mode = 'idle' | 'ws' | 'rest';
let mode: Mode = 'idle';
let stopped = false;

let ws: WebSocket | null = null;
let backoffMs = 1_000;
let reconnectTimer: NodeJS.Timeout | null = null;
let probeTimer: NodeJS.Timeout | null = null;
let restTimer: NodeJS.Timeout | null = null;
let wsRetryTimer: NodeJS.Timeout | null = null;
/** 현재 WS 연결에서 데이터 프레임을 한 번이라도 받았는지 (차단 판정용) */
let wsGotFrame = false;

// ── REST 폴백 ─────────────────────────────────────────────────────────────────

async function restPollOnce(): Promise<void> {
  try {
    const { data } = await axios.get(BINANCE_REST_PRICE, { timeout: 8_000 });
    // symbol 미지정이면 전체 배열. 우리 심볼만 추출.
    const arr: { symbol: string; price: string }[] = Array.isArray(data) ? data : [data];
    const wanted = new Set(GAP_PERP_SYMBOLS);
    for (const item of arr) {
      if (!wanted.has(item.symbol)) continue;
      const code = CODE_BY_PERP_SYMBOL[item.symbol];
      const price = Number(item.price);
      if (code && Number.isFinite(price)) updateExPrice('binance', code, price);
    }
  } catch (err) {
    logger.warn(`[Binance] REST 폴백 실패: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function startRestMode(): void {
  mode = 'rest';
  void restPollOnce();
  restTimer = setInterval(() => void restPollOnce(), env.binanceRestPollMs);
  // 폴백 중에도 주기적으로 WS 재시도 (해외 배포 시 WS 복귀)
  wsRetryTimer = setTimeout(() => {
    stopRestMode();
    connectWs();
  }, WS_RETRY_MS);
  logger.info(`[Binance] REST 폴백 모드 (${env.binanceRestPollMs}ms 주기, ${WS_RETRY_MS / 1000}s 후 WS 재시도)`);
}

function stopRestMode(): void {
  if (restTimer) {
    clearInterval(restTimer);
    restTimer = null;
  }
  if (wsRetryTimer) {
    clearTimeout(wsRetryTimer);
    wsRetryTimer = null;
  }
}

// ── WS ────────────────────────────────────────────────────────────────────────

function clearProbe(): void {
  if (probeTimer) {
    clearTimeout(probeTimer);
    probeTimer = null;
  }
}

function scheduleReconnect(): void {
  if (stopped || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWs();
  }, backoffMs);
  backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
}

function connectWs(): void {
  if (stopped) return;
  mode = 'ws';
  wsGotFrame = false;

  const streams = GAP_PERP_SYMBOLS.map((s) => `${s.toLowerCase()}@aggTrade`).join('/');
  const sock = new WebSocket(`${BINANCE_WS_URL}?streams=${streams}`);
  ws = sock;

  sock.on('open', () => {
    logger.info('[Binance] WS 연결 — 프레임 수신 probe 중');
    // probe: 일정 시간 내 프레임 0건이면 차단으로 보고 REST 폴백
    clearProbe();
    probeTimer = setTimeout(() => {
      if (!wsGotFrame) {
        logger.warn('[Binance] WS 프레임 0건 — 차단 추정, REST 폴백 전환');
        sock.close();
        startRestMode();
      }
    }, env.binanceWsProbeMs);
  });

  sock.on('message', (buf: WebSocket.RawData) => {
    try {
      const msg = JSON.parse(buf.toString());
      const d = msg.data ?? {};
      if (!d.s) return;
      const code = CODE_BY_PERP_SYMBOL[String(d.s).toUpperCase()];
      const price = Number(d.p);
      if (code && Number.isFinite(price)) {
        wsGotFrame = true;
        backoffMs = 1_000;
        updateExPrice('binance', code, price);
      }
    } catch {
      /* 무시 */
    }
  });

  sock.on('error', (err) => {
    logger.warn(`[Binance] WS 에러: ${err instanceof Error ? err.message : String(err)}`);
  });

  sock.on('close', () => {
    if (ws === sock) ws = null;
    clearProbe();
    // REST 폴백으로 의도적 close한 경우(mode==='rest')는 재연결 안 함.
    if (!stopped && mode === 'ws') {
      scheduleReconnect();
    }
  });
}

/** Binance 수집 시작 (WS 우선) */
export function startBinanceFeed(): void {
  stopped = false;
  backoffMs = 1_000;
  connectWs();
}

/** Binance 수집 중지 (WS/REST 모드 무관 전부 정리) */
export function stopBinanceFeed(): void {
  stopped = true;
  mode = 'idle';
  clearProbe();
  stopRestMode();
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    ws.close();
    ws = null;
  }
}
