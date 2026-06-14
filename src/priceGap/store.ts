/**
 * Price Gap Monitor — 인메모리 상태 저장소 (모듈 싱글톤).
 *
 * 책임:
 *   1) 소스별 최신값 cache (KR 체결가 / 거래소 perp 가격 / USDT/KRW)
 *   2) 갭 히스토리 10분 rolling buffer (Basic 10분 지연 노출용)
 *   3) stale 판정 (장중인데 일정 시간 무수신이면 해당 소스 stale)
 *
 * 휘발성: 프로세스 메모리. 서버 재시작 시 전부 소실 → 재시작 직후 ~10분간
 * Basic은 warming-up 상태(buffer 미충족). 영속화는 MVP 범위 밖(과설계).
 *
 * 수집기(kis/bybit/binance/fx feed)는 updateXxx()로 값을 밀어넣기만 하고
 * 갭 계산은 모른다(관심사 분리). 갭 계산/buffer push는 1초 tick(lifecycle)에서 수행.
 */
import { computeGap } from './gap';
import { GAP_STOCKS, EXCHANGES } from './symbols';
import type { GapExchange, GapTick, GapSnapshotRow } from '../types';

/** 소스 신선도 임계 — 장중 이 시간 이상 무수신이면 stale */
const STALE_MS = 15_000;
/** 갭 히스토리 보관 기간 (Basic 10분 지연 + 여유 5분) */
const BUFFER_MS = 15 * 60_000;

interface PricePoint {
  price: number;
  ts: number; // epoch ms
}

// ── 최신값 cache ──────────────────────────────────────────────────────────────
/** 종목코드 → 원화 체결가 (KIS WS) */
const latestKr = new Map<string, PricePoint>();
/** `${exchange}:${code}` → perp 가격 (거래소 WS/REST) */
const latestEx = new Map<string, PricePoint>();
/** USDT/KRW (FX 폴러). 단일값. */
let latestFx: PricePoint | null = null;

// ── 갭 히스토리 10분 buffer ───────────────────────────────────────────────────
/** `${exchange}:${code}` → 시간순 GapTick[] (오래된 것이 앞) */
const gapHistory = new Map<string, GapTick[]>();

function exKey(exchange: GapExchange, code: string): string {
  return `${exchange}:${code}`;
}

// ── 수집기가 호출하는 update API ──────────────────────────────────────────────

/** KIS 수집기: 원화 체결가 갱신 */
export function updateKrPrice(code: string, price: number, ts: number = Date.now()): void {
  latestKr.set(code, { price, ts });
}

/** 거래소 수집기: perp 가격 갱신 */
export function updateExPrice(
  exchange: GapExchange,
  code: string,
  price: number,
  ts: number = Date.now(),
): void {
  latestEx.set(exKey(exchange, code), { price, ts });
}

/** FX 폴러: USDT/KRW 갱신 */
export function updateFx(price: number, ts: number = Date.now()): void {
  latestFx = { price, ts };
}

// ── stale 판정 ────────────────────────────────────────────────────────────────

function isStale(point: PricePoint | null, now: number): boolean {
  return point === null || now - point.ts > STALE_MS;
}

/** 현재 소스별 stale 상태 스냅샷 (운영 가시성 / latest 응답용) */
export function staleFlags(now: number = Date.now()): {
  fx: boolean;
  kr: Record<string, boolean>;
  ex: Record<string, boolean>;
} {
  const kr: Record<string, boolean> = {};
  const ex: Record<string, boolean> = {};
  for (const s of GAP_STOCKS) {
    kr[s.code] = isStale(latestKr.get(s.code) ?? null, now);
    for (const e of EXCHANGES) {
      ex[exKey(e, s.code)] = isStale(latestEx.get(exKey(e, s.code)) ?? null, now);
    }
  }
  return { fx: isStale(latestFx, now), kr, ex };
}

// ── 1초 tick: 갭 계산 + buffer push ──────────────────────────────────────────

/**
 * 현재 최신값으로 (종목 × 거래소) 전 조합의 갭을 계산해 GapTick[]을 만든다.
 * stale인 소스는 null로 흘려 gap=null이 되게 한다(허위 갭 방지).
 * 부수효과: gapHistory에 push + 만료 prune.
 */
export function tick(now: number = Date.now()): GapTick[] {
  const fxPoint = latestFx;
  const fxPrice = fxPoint && !isStale(fxPoint, now) ? fxPoint.price : null;

  const ticks: GapTick[] = [];
  for (const s of GAP_STOCKS) {
    const krPoint = latestKr.get(s.code) ?? null;
    const krPrice = krPoint && !isStale(krPoint, now) ? krPoint.price : null;

    for (const exchange of EXCHANGES) {
      const exPoint = latestEx.get(exKey(exchange, s.code)) ?? null;
      const exPrice = exPoint && !isStale(exPoint, now) ? exPoint.price : null;

      const { usdRef, gap } = computeGap(krPrice, fxPrice, exPrice);
      const gapTick: GapTick = {
        ts: now,
        stockCode: s.code,
        exchange,
        krPrice,
        usdRef,
        exPrice,
        gap,
      };
      ticks.push(gapTick);
      pushHistory(exchange, s.code, gapTick, now);
    }
  }
  return ticks;
}

function pushHistory(exchange: GapExchange, code: string, t: GapTick, now: number): void {
  const key = exKey(exchange, code);
  let arr = gapHistory.get(key);
  if (!arr) {
    arr = [];
    gapHistory.set(key, arr);
  }
  arr.push(t);
  // 만료 prune — 앞쪽(오래된) 제거. buffer 기간 밖이면 shift.
  const cutoff = now - BUFFER_MS;
  let drop = 0;
  while (drop < arr.length && arr[drop].ts < cutoff) drop++;
  if (drop > 0) arr.splice(0, drop);
}

// ── 조회 API (latest 라우트용) ────────────────────────────────────────────────

/** Premium: 현재 최신 스냅샷 (전 조합) */
export function snapshotLatest(now: number = Date.now()): GapSnapshotRow[] {
  return tick(now).map(toRow);
}

/**
 * Basic: T-delayMs 시점에 가장 가까운(이하) 갭 스냅샷.
 * buffer가 아직 delay만큼 안 찼으면 warmingUp=true.
 */
export function snapshotDelayed(
  delayMs: number,
  now: number = Date.now(),
): { rows: GapSnapshotRow[]; warmingUp: boolean } {
  const target = now - delayMs;
  const rows: GapSnapshotRow[] = [];
  let warmingUp = false;

  for (const s of GAP_STOCKS) {
    for (const exchange of EXCHANGES) {
      const arr = gapHistory.get(exKey(exchange, s.code)) ?? [];
      const found = nearestAtOrBefore(arr, target);
      if (!found) {
        warmingUp = true;
        continue;
      }
      rows.push(toRow(found));
    }
  }
  return { rows, warmingUp };
}

/** 정렬된 배열에서 ts <= target 인 가장 최신 항목 (이진탐색) */
function nearestAtOrBefore(arr: GapTick[], target: number): GapTick | null {
  let lo = 0;
  let hi = arr.length - 1;
  let ans: GapTick | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].ts <= target) {
      ans = arr[mid];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

function toRow(t: GapTick): GapSnapshotRow {
  const meta = GAP_STOCKS.find((s) => s.code === t.stockCode);
  return {
    stockCode: t.stockCode,
    stockName: meta?.name ?? t.stockCode,
    exchange: t.exchange,
    krPrice: t.krPrice,
    usdRef: t.usdRef,
    exPrice: t.exPrice,
    gap: t.gap,
    ts: t.ts,
  };
}

/** 현재 USDT/KRW 값 (latest 응답의 환율 카드용). stale이면 값은 주되 플래그로 구분. */
export function currentFx(now: number = Date.now()): { price: number; ts: number; stale: boolean } | null {
  if (!latestFx) return null;
  return { price: latestFx.price, ts: latestFx.ts, stale: isStale(latestFx, now) };
}

/** 전체 상태 초기화 (lifecycle.stop / 테스트용) */
export function reset(): void {
  latestKr.clear();
  latestEx.clear();
  latestFx = null;
  gapHistory.clear();
}
