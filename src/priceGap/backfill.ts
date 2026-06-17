/**
 * Price Gap Monitor — 과거 1분봉 백필 (1회성 배치 + 일일 증분).
 *
 * 실시간 수집기(WS/REST)는 "지금"만 본다. 차트 평균선·테이블 과거평균은 N거래일치 과거가
 * 필요하므로, 세 소스의 "과거 1분봉"을 받아 같은 분(minute)에 조합해 갭을 재계산하고
 * price_gap_ohlc에 적재한다(멱등 upsert).
 *
 * 데이터 소스 (전부 과거 1분봉 제공 — claudedocs/price_gap_backfill_feasibility.md 실측):
 *   KR 체결가 : KIS inquire-time-dailychartprice (FHKST03010230) — 과거 영업일 분봉, 시각 역순 페이징
 *   USDT/KRW  : Upbit candles/minutes/1 (to 파라미터) — 종목 무관 공통, 시각 역순 페이징
 *   perp      : 거래소 klines (Binance fapi / Bybit v5) — UTC openTime
 *
 * 정렬 원칙: 세 소스의 시각을 전부 "UTC 분 경계 키(floor(ms/60000))"로 통일해 조인한다.
 * 재계산 한계: 1초 raw가 없으므로 각 소스의 1분봉 close끼리 갭을 계산한다. 따라서 백필분
 *   OHLC는 close_gap만 정확하고 o/h/l은 close 복제(근사). 평균선/과거평균은 close만 쓰므로 무방.
 *
 * 한국 장중(09:00~15:35 KST) 분만 백필한다(그 밖엔 KR 체결가가 없어 gap 계산 불가).
 * 휴장일은 KIS가 빈 응답 → 자동 스킵.
 */
import axios from 'axios';
import { KIS_BASE, kisHeaders } from '../config/kisAuth';
import { upsertOhlc } from '../services/priceGap.service';
import { computeGap } from './gap';
import { GAP_STOCKS, EXCHANGES } from './symbols';
import type { GapStockMeta } from './symbols';
import { isOpenDay } from './holiday';
import { withRetry, sleep, KIS_CALL_GAP_MS, kstYmd } from '../collectors/publicCommon';
import { logger } from '../utils/logger';
import type { GapExchange } from '../types';

// ── 분 경계 키 유틸 ─────────────────────────────────────────────────────────────

/** epoch ms → UTC 분 경계 키 (floor(ms/60000)). 세 소스 공통 조인 키. */
function minuteKey(ms: number): number {
  return Math.floor(ms / 60_000);
}

/** 분 경계 키 → ISO (price_gap_ohlc.timestamp_minute 형식, UTC) */
function minuteKeyToIso(key: number): string {
  return new Date(key * 60_000).toISOString();
}

/**
 * KST 영업일(YYYYMMDD)의 장 시간창(09:00~15:35 KST)을 UTC epoch ms 범위로.
 * KST = UTC+9 (DST 없음)이라 고정 오프셋으로 변환한다.
 */
function sessionRangeUtcMs(ymd: string): { startMs: number; endMs: number } {
  const y = Number(ymd.slice(0, 4));
  const mo = Number(ymd.slice(4, 6));
  const d = Number(ymd.slice(6, 8));
  // KST 09:00 = UTC 00:00 당일, KST 15:35 = UTC 06:35 당일. Date.UTC로 직접 구성.
  const startMs = Date.UTC(y, mo - 1, d, 0, 0, 0); // 09:00 KST
  const endMs = Date.UTC(y, mo - 1, d, 6, 35, 0); // 15:35 KST
  return { startMs, endMs };
}

// ── 소스별 fetch: 반환은 모두 Map<분키, close가격> ───────────────────────────────

/**
 * KR 체결가 1분봉 (KIS). 해당 영업일 09:00~15:35의 분봉 close를 분키→가격 맵으로.
 * 한 호출당 최대 ~120건(약 2시간)이라 FID_INPUT_HOUR_1을 당겨가며 09:00까지 역순 페이징.
 */
async function fetchKrMinutes(code: string, ymd: string): Promise<Map<number, number>> {
  const PATH = '/uapi/domestic-stock/v1/quotations/inquire-time-dailychartprice';
  const TR_ID = 'FHKST03010230';
  const out = new Map<number, number>();

  // 역순 페이징: 15:35부터 시작해, 받은 가장 이른 분 직전으로 hour를 당긴다.
  let hour = '153500';
  let guard = 0;
  while (guard++ < 12) {
    const headers = await kisHeaders(TR_ID);
    const { data } = await axios.get(`${KIS_BASE}${PATH}`, {
      headers,
      params: {
        FID_COND_MRKT_DIV_CODE: 'J',
        FID_INPUT_ISCD: code,
        FID_INPUT_DATE_1: ymd,
        FID_INPUT_HOUR_1: hour,
        FID_PW_DATA_INCU_YN: 'N',
        FID_FAKE_TICK_INCU_YN: 'N',
      },
      timeout: 10_000,
    });
    if (data.rt_cd !== '0') {
      throw new Error(`KIS 분봉 오류 (${data.rt_cd}): ${data.msg1}`);
    }
    const rows: { stck_bsop_date: string; stck_cntg_hour: string; stck_prpr: string }[] =
      data.output2 ?? [];
    if (rows.length === 0) break;

    let earliestHhmmss = hour;
    for (const r of rows) {
      const hhmmss = r.stck_cntg_hour; // KST HHMMSS
      const price = Number(r.stck_prpr);
      if (!/^\d{6}$/.test(hhmmss) || !Number.isFinite(price) || price <= 0) continue;
      const hh = Number(hhmmss.slice(0, 2));
      const mm = Number(hhmmss.slice(2, 4));
      // 09:00~15:35 KST 밖이면 스킵
      const minutesKst = hh * 60 + mm;
      if (minutesKst < 9 * 60 || minutesKst > 15 * 60 + 35) continue;
      // 해당 KST 분 → UTC ms → 분키. KST=UTC+9 고정.
      const y = Number(ymd.slice(0, 4));
      const mo = Number(ymd.slice(4, 6));
      const d = Number(ymd.slice(6, 8));
      const utcMs = Date.UTC(y, mo - 1, d, hh - 9, mm, 0);
      out.set(minuteKey(utcMs), price);
      if (hhmmss < earliestHhmmss) earliestHhmmss = hhmmss;
    }

    // 09:00에 도달했거나 더 못 당기면 종료
    if (earliestHhmmss <= '090000' || earliestHhmmss === hour) break;
    // 다음 페이지: 받은 가장 이른 분의 1분 전 시각으로
    const eh = Number(earliestHhmmss.slice(0, 2));
    const em = Number(earliestHhmmss.slice(2, 4));
    const prev = eh * 60 + em - 1;
    if (prev < 9 * 60) break;
    hour = `${String(Math.floor(prev / 60)).padStart(2, '0')}${String(prev % 60).padStart(2, '0')}00`;
    await sleep(KIS_CALL_GAP_MS);
  }
  return out;
}

/**
 * USDT/KRW 1분봉 (Upbit). 해당일 장 시간창의 분봉 close(trade_price)를 분키→가격 맵으로.
 * 한 콜당 최대 200봉. to(UTC ISO)를 당겨가며 역순 페이징. 종목 무관 공통이라 1일 1회만 호출.
 */
async function fetchFxMinutes(ymd: string): Promise<Map<number, number>> {
  const URL = 'https://api.upbit.com/v1/candles/minutes/1';
  const out = new Map<number, number>();
  const { startMs, endMs } = sessionRangeUtcMs(ymd);

  // to는 "이 시각 이전" 분봉을 준다. endMs+1분부터 시작해 startMs까지 역순.
  let toMs = endMs + 60_000;
  let guard = 0;
  while (guard++ < 5) {
    const toIso = new Date(toMs).toISOString();
    const { data } = await axios.get(URL, {
      params: { market: 'KRW-USDT', count: 200, to: toIso },
      timeout: 10_000,
    });
    const rows: { candle_date_time_utc: string; trade_price: number; timestamp: number }[] =
      Array.isArray(data) ? data : [];
    if (rows.length === 0) break;

    let earliestMs = toMs;
    for (const r of rows) {
      // candle_date_time_utc는 'Z' 없는 UTC. ms로 파싱해 분키 생성.
      const ms = Date.parse(`${r.candle_date_time_utc}Z`);
      if (!Number.isFinite(ms)) continue;
      if (ms < startMs || ms > endMs) continue;
      const price = Number(r.trade_price);
      if (Number.isFinite(price) && price > 0) out.set(minuteKey(ms), price);
      if (ms < earliestMs) earliestMs = ms;
    }
    if (earliestMs <= startMs || earliestMs === toMs) break;
    toMs = earliestMs; // 다음 페이지: 가장 이른 봉 이전
    await sleep(120); // Upbit rate limit 여유
  }
  return out;
}

/** Binance perp 1분봉. startTime~endTime의 close를 분키→가격 맵으로. 한 콜 최대 1500봉. */
async function fetchBinanceMinutes(symbol: string, startMs: number, endMs: number): Promise<Map<number, number>> {
  const URL = 'https://fapi.binance.com/fapi/v1/klines';
  const out = new Map<number, number>();
  const { data } = await axios.get(URL, {
    params: { symbol, interval: '1m', startTime: startMs, endTime: endMs, limit: 1500 },
    timeout: 10_000,
  });
  // kline: [openTime, open, high, low, close, volume, closeTime, ...]
  const rows: unknown[][] = Array.isArray(data) ? data : [];
  for (const r of rows) {
    const openMs = Number(r[0]);
    const close = Number(r[4]);
    if (Number.isFinite(openMs) && Number.isFinite(close) && close > 0) {
      out.set(minuteKey(openMs), close);
    }
  }
  return out;
}

/** Bybit perp 1분봉. start~end의 close를 분키→가격 맵으로. 한 콜 최대 1000봉, 역순 반환. */
async function fetchBybitMinutes(symbol: string, startMs: number, endMs: number): Promise<Map<number, number>> {
  const URL = 'https://api.bybit.com/v5/market/kline';
  const out = new Map<number, number>();
  const { data } = await axios.get(URL, {
    params: { category: 'linear', symbol, interval: '1', start: startMs, end: endMs, limit: 1000 },
    timeout: 10_000,
  });
  // list: [start(ms,str), open, high, low, close, volume, turnover] — 역순(최신 먼저)
  const rows: string[][] = data?.result?.list ?? [];
  for (const r of rows) {
    const openMs = Number(r[0]);
    const close = Number(r[4]);
    if (Number.isFinite(openMs) && Number.isFinite(close) && close > 0) {
      out.set(minuteKey(openMs), close);
    }
  }
  return out;
}

/** 거래소 분봉 라우팅 */
async function fetchExMinutes(
  exchange: GapExchange,
  symbol: string,
  startMs: number,
  endMs: number,
): Promise<Map<number, number>> {
  return exchange === 'binance'
    ? fetchBinanceMinutes(symbol, startMs, endMs)
    : fetchBybitMinutes(symbol, startMs, endMs);
}

// ── 하루치 백필 ─────────────────────────────────────────────────────────────────

export interface BackfillDayResult {
  ymd: string;
  upserted: number;
  /** 종목×거래소별 매칭된 분 수 (디버깅/검증용) */
  matchedByPair: Record<string, number>;
}

/**
 * 한 영업일(KST YYYYMMDD)을 백필한다.
 * @param dryRun true면 DB upsert 없이 매칭/계산만 수행(검증용).
 */
export async function backfillDay(ymd: string, dryRun = false): Promise<BackfillDayResult> {
  const { startMs, endMs } = sessionRangeUtcMs(ymd);
  const matchedByPair: Record<string, number> = {};
  let upserted = 0;

  // USDT/KRW는 종목 무관 공통 — 하루 1회만 조회
  const fxMap = await withRetry(() => fetchFxMinutes(ymd));
  if (fxMap.size === 0) {
    logger.warn(`[Backfill] ${ymd}: USDT/KRW 분봉 0건 — 이 날 스킵`);
    return { ymd, upserted: 0, matchedByPair };
  }

  for (const stock of GAP_STOCKS as readonly GapStockMeta[]) {
    // KR 체결가 분봉 (종목별, 거래소 무관 공통)
    const krMap = await withRetry(() => fetchKrMinutes(stock.code, ymd));
    await sleep(KIS_CALL_GAP_MS);
    if (krMap.size === 0) continue; // 휴장/데이터 없음

    for (const exchange of EXCHANGES) {
      const exMap = await withRetry(() => fetchExMinutes(exchange, stock.perpSymbol, startMs, endMs));
      const pair = `${exchange}:${stock.code}`;
      let matched = 0;

      // 세 맵을 분키로 조인 — KR 분을 기준으로(장중 분만)
      for (const [mk, krPrice] of krMap) {
        const fxPrice = fxMap.get(mk);
        const exPrice = exMap.get(mk);
        if (fxPrice === undefined || exPrice === undefined) continue;
        const { usdRef, gap } = computeGap(krPrice, fxPrice, exPrice);
        if (gap === null) continue;

        matched++;
        if (!dryRun) {
          await upsertOhlc({
            timestamp_minute: minuteKeyToIso(mk),
            stock_code: stock.code,
            stock_name: stock.name,
            exchange,
            // 백필분: close_gap만 정확. o/h/l은 close 복제(분내 1초 변동 복원 불가).
            open_gap: gap,
            high_gap: gap,
            low_gap: gap,
            close_gap: gap,
            avg_gap: gap,
            // 분봉 close 원시가격도 보존(재배포 폴백 가격 복원용). 세 소스 분봉 close.
            close_kr_price: krPrice,
            close_usd_ref: usdRef,
            close_ex_price: exPrice,
          });
          upserted++;
        }
      }
      matchedByPair[pair] = matched;
      await sleep(150); // 거래소 rate limit 여유
    }
  }

  return { ymd, upserted, matchedByPair };
}

// ── 기간 백필 (6/2 ~ 어제) ──────────────────────────────────────────────────────

/** 주어진 시각의 KST 요일(0=일~6=토). 정오(KST=03:00 UTC) 기준이라 경계 오차 없음. */
function kstWeekday(d: Date): number {
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Seoul', weekday: 'short' })
    .format(d);
  const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[wd] ?? 0;
}

/** start~end(KST YYYYMMDD) 사이의 평일+개장일 목록. holiday 캐시로 휴장 제외. */
function tradingDays(startYmd: string, endYmd: string): string[] {
  const days: string[] = [];
  // 각 날짜의 KST 정오를 기준 시각으로 잡아 요일/날짜 판정의 경계 오차를 없앤다.
  const noonUtcOf = (ymd: string) =>
    new Date(Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8)), 3, 0, 0));
  const cur = noonUtcOf(startYmd);
  const end = noonUtcOf(endYmd);
  while (cur <= end) {
    const ymd = kstYmd(cur);
    const dow = kstWeekday(cur);
    const isWeekend = dow === 0 || dow === 6;
    // isOpenDay는 캐시 미보유 시 true(개장 간주)라 평일 체크를 병행한다.
    if (!isWeekend && isOpenDay(cur)) days.push(ymd);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return days;
}

export interface BackfillRangeResult {
  days: string[];
  totalUpserted: number;
  perDay: BackfillDayResult[];
}

/**
 * start~end(KST YYYYMMDD) 기간 백필.
 * @param dryRun true면 첫 영업일만 매칭 검증(전체 DB 적재 안 함).
 */
export async function backfillRange(startYmd: string, endYmd: string, dryRun = false): Promise<BackfillRangeResult> {
  const days = tradingDays(startYmd, endYmd);
  logger.info(`[Backfill] ${startYmd}~${endYmd} 영업일 ${days.length}일${dryRun ? ' (DRY-RUN: 첫날만)' : ''}`);

  const perDay: BackfillDayResult[] = [];
  let totalUpserted = 0;
  const targets = dryRun ? days.slice(0, 1) : days;
  for (const ymd of targets) {
    const r = await backfillDay(ymd, dryRun);
    perDay.push(r);
    totalUpserted += r.upserted;
    logger.info(`[Backfill] ${ymd}: upserted=${r.upserted} matched=${JSON.stringify(r.matchedByPair)}`);
  }
  return { days: targets, totalUpserted, perDay };
}

// ── 일일 증분 백필 (안전망) ─────────────────────────────────────────────────────

/** KST 기준 어제 YYYYMMDD. */
function yesterdayKstYmd(now: number = Date.now()): string {
  return kstYmd(new Date(now - 24 * 60 * 60 * 1000));
}

/**
 * 일일 증분 백필 — 전일 1영업일을 다시 적재한다(안전망).
 *
 * 실시간 수집(09:00~15:40)이 정상이면 그날 OHLC는 이미 price_gap_ohlc에 다 들어가 있다.
 * 그러나 장중 크래시·재배포로 일부 분이 누락될 수 있다. 이 잡이 전일분을 멱등 upsert로
 * 다시 메워, 실시간이 놓친 구멍을 보정한다(이미 있는 분은 같은 값으로 덮어쓰기뿐 — 무해).
 *
 * 전일이 휴장(주말·공휴일)이면 tradingDays가 빈 목록을 줘 자동 no-op.
 * @returns 보정된 영업일(있으면 그 YYYYMMDD, 없으면 null)
 */
export async function backfillYesterday(now: number = Date.now()): Promise<string | null> {
  const ymd = yesterdayKstYmd(now);
  const result = await backfillRange(ymd, ymd, false);
  if (result.days.length === 0) {
    logger.info(`[Backfill] 일일 증분 — 전일(${ymd})은 휴장/주말, 스킵`);
    return null;
  }
  return ymd;
}
