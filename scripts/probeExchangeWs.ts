/**
 * 거래소 WebSocket PoC — Binance/Bybit 한국주식 연계 무기한선물 실시간 수집 검증.
 *
 * 검증 목적 (Price Gap Monitor 사전 PoC):
 *   1) R2: 현재 서버 IP에서 거래소 WS가 실제로 붙는지 (한국 리전 차단 여부 실측)
 *   2) SAMSUNGUSDT / SKHYNIXUSDT / HYUNDAIUSDT perp의 실시간 체결가 수신 가능 여부
 *   3) 마크프라이스 + 펀딩레이트 동시 수신 가능 여부 (갭의 분자 후보 비교용)
 *   4) 메시지 빈도/지연 감각 (SSE 1초 푸시 설계 근거)
 *
 * 실행:  npx tsx scripts/probeExchangeWs.ts
 *   - 기본 RUN_MS(20초) 동안 수신 후 요약 리포트 출력하고 종료.
 *   - 외부 의존성 없음(ws만 사용, 인증 불필요한 public 스트림).
 *
 * 주의: 이 스크립트는 일회성 진단용이다. 운영 컬렉터가 아니다.
 */
import WebSocket from 'ws';
import axios from 'axios';

const SYMBOLS = ['SAMSUNGUSDT', 'SKHYNIXUSDT', 'HYUNDAIUSDT'] as const;
type Symbol = (typeof SYMBOLS)[number];

/** 수신 관측 시간. 인자로 덮어쓸 수 있다: tsx scripts/probeExchangeWs.ts 30000 */
const RUN_MS = Number(process.argv[2]) || 20_000;

const BINANCE_REST = 'https://fapi.binance.com';
const BYBIT_REST = 'https://api.bybit.com';
const BINANCE_WS = 'wss://fstream.binance.com/stream';
const BYBIT_WS = 'wss://stream.bybit.com/v5/public/linear';

/** 거래소별·종목별 수신 카운터/최신값 (요약 리포트용) */
interface Stat {
  trades: number;
  lastPrice: number | null;
  markPrice: number | null;
  fundingRate: number | null;
  firstTs: number | null;
  lastTs: number | null;
}
function emptyStat(): Stat {
  return { trades: 0, lastPrice: null, markPrice: null, fundingRate: null, firstTs: null, lastTs: null };
}
const binanceStats: Record<string, Stat> = Object.fromEntries(SYMBOLS.map((s) => [s, emptyStat()]));
const bybitStats: Record<string, Stat> = Object.fromEntries(SYMBOLS.map((s) => [s, emptyStat()]));

function now(): number {
  return Date.now();
}
function log(...args: unknown[]): void {
  // eslint 무관(scripts는 include 밖). 진단 출력이라 console 사용.
  console.log(`[${new Date().toISOString()}]`, ...args);
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 1) REST 사전 확인 — 심볼 3종이 실제 거래 중인지 + 기준 가격 스냅샷
// ─────────────────────────────────────────────────────────────────────────────
async function restPrecheck(): Promise<void> {
  log('── STEP 1: REST 사전 확인 ──');

  // Binance: 심볼별 ticker/price + premiumIndex(마크/펀딩)
  for (const sym of SYMBOLS) {
    try {
      const [price, premium] = await Promise.all([
        axios.get(`${BINANCE_REST}/fapi/v1/ticker/price`, { params: { symbol: sym }, timeout: 10_000 }),
        axios.get(`${BINANCE_REST}/fapi/v1/premiumIndex`, { params: { symbol: sym }, timeout: 10_000 }),
      ]);
      log(
        `  Binance ${sym}: last=${price.data.price} mark=${premium.data.markPrice} ` +
          `funding=${premium.data.lastFundingRate} nextFunding=${new Date(premium.data.nextFundingTime).toISOString()}`,
      );
    } catch (err) {
      log(`  ❌ Binance ${sym} REST 실패:`, axios.isAxiosError(err) ? `${err.response?.status} ${JSON.stringify(err.response?.data)}` : String(err));
    }
  }

  // Bybit: instruments-info(존재/상태) + tickers(가격/마크/펀딩)
  for (const sym of SYMBOLS) {
    try {
      const t = await axios.get(`${BYBIT_REST}/v5/market/tickers`, {
        params: { category: 'linear', symbol: sym },
        timeout: 10_000,
      });
      const item = t.data?.result?.list?.[0];
      if (t.data?.retCode !== 0 || !item) {
        log(`  ⚠️  Bybit ${sym}: retCode=${t.data?.retCode} msg=${t.data?.retMsg} (데이터 없음)`);
        continue;
      }
      log(
        `  Bybit ${sym}: last=${item.lastPrice} mark=${item.markPrice} ` +
          `funding=${item.fundingRate} nextFunding=${new Date(Number(item.nextFundingTime)).toISOString()}`,
      );
    } catch (err) {
      log(`  ❌ Bybit ${sym} REST 실패:`, axios.isAxiosError(err) ? `${err.response?.status} ${JSON.stringify(err.response?.data)}` : String(err));
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 2a) Binance WS — combined stream: aggTrade(체결) + markPrice(마크/펀딩)
// ─────────────────────────────────────────────────────────────────────────────
function connectBinance(): WebSocket {
  // <symbol>@aggTrade : 실시간 체결, <symbol>@markPrice@1s : 1초 마크프라이스+펀딩
  const streams = SYMBOLS.flatMap((s) => [`${s.toLowerCase()}@aggTrade`, `${s.toLowerCase()}@markPrice@1s`]).join('/');
  const url = `${BINANCE_WS}?streams=${streams}`;
  const ws = new WebSocket(url);

  ws.on('open', () => log('✅ Binance WS 연결됨 →', url));
  ws.on('message', (buf: WebSocket.RawData) => {
    try {
      const msg = JSON.parse(buf.toString());
      const stream: string = msg.stream ?? '';
      const d = msg.data ?? {};
      const sym = (d.s ?? '').toUpperCase() as Symbol;
      if (!binanceStats[sym]) return;
      const st = binanceStats[sym];
      st.firstTs ??= now();
      st.lastTs = now();

      if (stream.endsWith('@aggTrade')) {
        st.trades += 1;
        st.lastPrice = Number(d.p);
      } else if (stream.includes('@markPrice')) {
        st.markPrice = Number(d.p);
        st.fundingRate = Number(d.r);
      }
    } catch {
      /* 파싱 실패 무시(진단) */
    }
  });
  ws.on('error', (err) => log('❌ Binance WS 에러:', err instanceof Error ? err.message : String(err)));
  ws.on('close', (code, reason) => log(`Binance WS 닫힘 code=${code} reason=${reason?.toString()}`));
  return ws;
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 2b) Bybit WS — publicTrade(체결) + tickers(마크/펀딩)
// ─────────────────────────────────────────────────────────────────────────────
function connectBybit(): WebSocket {
  const ws = new WebSocket(BYBIT_WS);
  const args = SYMBOLS.flatMap((s) => [`publicTrade.${s}`, `tickers.${s}`]);

  ws.on('open', () => {
    log('✅ Bybit WS 연결됨 →', BYBIT_WS);
    ws.send(JSON.stringify({ op: 'subscribe', args }));
  });
  ws.on('message', (buf: WebSocket.RawData) => {
    try {
      const msg = JSON.parse(buf.toString());
      if (msg.op === 'subscribe') {
        log(`  Bybit subscribe ack: success=${msg.success} ${msg.ret_msg ?? ''}`);
        return;
      }
      const topic: string = msg.topic ?? '';
      if (topic.startsWith('publicTrade.')) {
        const sym = topic.slice('publicTrade.'.length) as Symbol;
        const st = bybitStats[sym];
        if (!st) return;
        st.firstTs ??= now();
        st.lastTs = now();
        const arr = Array.isArray(msg.data) ? msg.data : [];
        st.trades += arr.length;
        if (arr.length) st.lastPrice = Number(arr[arr.length - 1].p);
      } else if (topic.startsWith('tickers.')) {
        const sym = topic.slice('tickers.'.length) as Symbol;
        const st = bybitStats[sym];
        if (!st) return;
        st.firstTs ??= now();
        st.lastTs = now();
        const d = msg.data ?? {};
        if (d.markPrice !== undefined) st.markPrice = Number(d.markPrice);
        if (d.fundingRate !== undefined) st.fundingRate = Number(d.fundingRate);
        if (d.lastPrice !== undefined && st.lastPrice === null) st.lastPrice = Number(d.lastPrice);
      }
    } catch {
      /* 무시 */
    }
  });
  ws.on('error', (err) => log('❌ Bybit WS 에러:', err instanceof Error ? err.message : String(err)));
  ws.on('close', (code, reason) => log(`Bybit WS 닫힘 code=${code} reason=${reason?.toString()}`));
  return ws;
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 3) 요약 리포트
// ─────────────────────────────────────────────────────────────────────────────
function report(): void {
  const fmt = (st: Stat): string => {
    const span = st.firstTs && st.lastTs ? ((st.lastTs - st.firstTs) / 1000).toFixed(1) : '0';
    const rate = st.firstTs && st.lastTs && st.lastTs > st.firstTs
      ? (st.trades / ((st.lastTs - st.firstTs) / 1000)).toFixed(2)
      : '0';
    return `trades=${st.trades} (${rate}/s, ${span}s 관측) last=${st.lastPrice ?? '—'} mark=${st.markPrice ?? '—'} funding=${st.fundingRate ?? '—'}`;
  };

  log('');
  log('════════════════ 요약 리포트 ════════════════');
  log('── Binance WS ──');
  for (const s of SYMBOLS) log(`  ${s}: ${fmt(binanceStats[s])}`);
  log('── Bybit WS ──');
  for (const s of SYMBOLS) log(`  ${s}: ${fmt(bybitStats[s])}`);

  // 판정 요약
  const binanceOk = SYMBOLS.some((s) => binanceStats[s].lastPrice !== null);
  const bybitOk = SYMBOLS.some((s) => bybitStats[s].lastPrice !== null);
  log('');
  log(`판정 → Binance WS 수신: ${binanceOk ? '✅ OK' : '❌ 실패(차단/심볼/네트워크)'}`);
  log(`판정 → Bybit   WS 수신: ${bybitOk ? '✅ OK' : '❌ 실패(차단/심볼/네트워크)'}`);
  log('════════════════════════════════════════════');
}

async function main(): Promise<void> {
  log(`거래소 WS PoC 시작 — 관측 ${RUN_MS / 1000}초, 심볼=${SYMBOLS.join(',')}`);
  await restPrecheck();

  log('── STEP 2: WebSocket 구독 ──');
  const wsB = connectBinance();
  const wsY = connectBybit();

  await new Promise((r) => setTimeout(r, RUN_MS));

  report();
  wsB.close();
  wsY.close();
  // 소켓 정리 여유 후 종료(좀비 방지)
  setTimeout(() => process.exit(0), 500);
}

main().catch((err) => {
  log('치명적 오류:', err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
