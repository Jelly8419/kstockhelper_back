/**
 * Price Gap Monitor — Bybit WebSocket 수집기 (한국주식 연계 perp).
 *
 * wss://stream.bybit.com/v5/public/linear 에 tickers.<symbol> 구독.
 * tickers의 lastPrice를 perp 가격으로 store.updateExPrice('bybit', ...)에 전달.
 * (publicTrade는 MVP 미사용 — tickers.lastPrice로 충분, 대역폭 절감)
 *
 * tickers는 delta 스트림이라 lastPrice가 "거래 발생 시에만" 온다. 거래가 한산한
 * 종목은 구독 후 한동안 가격이 안 채워질 수 있어, 구독 직후 REST(/v5/market/tickers)로
 * 초기 스냅샷을 1회 받아 즉시 채운다. 이후엔 WS delta로 갱신.
 *
 * Bybit는 클라이언트가 20초마다 {op:'ping'}을 보내야 연결이 유지된다(KIS와 반대).
 * 한국 IP에서도 정상(PoC 검증). 끊기면 지수백오프 재연결.
 */
import WebSocket from 'ws';
import axios from 'axios';
import { updateExPrice } from './store';
import { GAP_PERP_SYMBOLS, CODE_BY_PERP_SYMBOL } from './symbols';
import { logger } from '../utils/logger';

const BYBIT_WS_URL = 'wss://stream.bybit.com/v5/public/linear';
const BYBIT_REST_TICKERS = 'https://api.bybit.com/v5/market/tickers';
const PING_MS = 20_000;
const MAX_BACKOFF_MS = 30_000;

let ws: WebSocket | null = null;
let stopped = false;
let backoffMs = 1_000;
let reconnectTimer: NodeJS.Timeout | null = null;
let pingTimer: NodeJS.Timeout | null = null;

/**
 * 구독 직후 REST로 초기 가격 스냅샷을 1회 채운다 (WS delta가 오기 전 빈 값 방지).
 * category=linear 전체 tickers 1콜 → 우리 심볼만 추출. 실패해도 WS로 결국 채워지므로 치명적 아님.
 */
async function primeFromRest(): Promise<void> {
  try {
    const { data } = await axios.get(BYBIT_REST_TICKERS, {
      params: { category: 'linear' },
      timeout: 8_000,
    });
    const list: { symbol: string; lastPrice: string }[] = data?.result?.list ?? [];
    const wanted = new Set(GAP_PERP_SYMBOLS);
    for (const item of list) {
      if (!wanted.has(item.symbol)) continue;
      const code = CODE_BY_PERP_SYMBOL[item.symbol];
      const price = Number(item.lastPrice);
      if (code && Number.isFinite(price)) updateExPrice('bybit', code, price);
    }
  } catch (err) {
    logger.warn(`[Bybit] REST 초기 스냅샷 실패(WS로 채워짐): ${err instanceof Error ? err.message : String(err)}`);
  }
}

function scheduleReconnect(): void {
  if (stopped || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, backoffMs);
  backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
}

function clearPing(): void {
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
}

function connect(): void {
  if (stopped) return;
  const sock = new WebSocket(BYBIT_WS_URL);
  ws = sock;

  sock.on('open', () => {
    backoffMs = 1_000;
    sock.send(JSON.stringify({ op: 'subscribe', args: GAP_PERP_SYMBOLS.map((s) => `tickers.${s}`) }));
    void primeFromRest(); // 구독 직후 초기 스냅샷으로 빈 값 방지
    clearPing();
    pingTimer = setInterval(() => {
      if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ op: 'ping' }));
    }, PING_MS);
    logger.info(`[Bybit] WS 연결 + ${GAP_PERP_SYMBOLS.length}심볼 tickers 구독`);
  });

  sock.on('message', (buf: WebSocket.RawData) => {
    try {
      const msg = JSON.parse(buf.toString());
      const topic: string = msg.topic ?? '';
      if (!topic.startsWith('tickers.')) return; // subscribe ack / pong 무시
      const symbol = topic.slice('tickers.'.length);
      const code = CODE_BY_PERP_SYMBOL[symbol];
      if (!code) return;
      // tickers는 delta 업데이트라 lastPrice가 매번 오진 않음 — 있을 때만 반영.
      const last = msg.data?.lastPrice;
      if (last !== undefined) {
        const price = Number(last);
        if (Number.isFinite(price)) updateExPrice('bybit', code, price);
      }
    } catch {
      /* 무시 */
    }
  });

  sock.on('error', (err) => {
    logger.warn(`[Bybit] WS 에러: ${err instanceof Error ? err.message : String(err)}`);
  });

  sock.on('close', (code) => {
    if (ws === sock) ws = null;
    clearPing();
    if (!stopped) {
      logger.warn(`[Bybit] WS 닫힘 (code=${code}) — 재연결 예약`);
      scheduleReconnect();
    }
  });
}

/** Bybit WS 수집 시작 */
export function startBybitFeed(): void {
  stopped = false;
  backoffMs = 1_000;
  connect();
}

/** Bybit WS 수집 중지 */
export function stopBybitFeed(): void {
  stopped = true;
  clearPing();
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    ws.close();
    ws = null;
  }
}
