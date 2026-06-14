/**
 * Price Gap Monitor — 한국 증시 개장일(휴장일) 캐시.
 *
 * KIS 국내휴장일조회(CTCA0903R)로 개장일 여부를 받아 메모리에 캐싱한다.
 * isPriceGapWindow()가 시각 판정에 더해 "오늘이 개장일인가"를 동기로 확인하게 해서,
 * 공휴일(평일이지만 휴장)에 marketOpen=true로 오판하는 걸 막는다.
 *
 * ⚠️ KIS 제약: chk-holiday는 원장서비스 연관이라 "가급적 1일 1회 호출" 권고.
 *   → 하루 1회만 조회하고 메모리에 캐싱한다(스케줄러가 새벽에 갱신).
 *   → 한 번 호출에 ~24일치를 주므로 향후 수 주를 한 번에 캐싱.
 *
 * 안전 원칙: 캐시에 해당 날짜가 없으면(조회 실패/미갱신) **개장으로 간주**한다.
 *   휴장일 조회 실패가 정상 장중 수집을 막으면 안 되기 때문(기존 시각판정 동작 유지).
 *   즉 이 캐시는 "휴장을 확신할 때만 끄는" 보강 장치다.
 */
import axios from 'axios';
import { KIS_BASE, kisHeaders } from '../config/kisAuth';
import { withRetry, kstYmd, isPriceGapWindow } from '../collectors/publicCommon';
import { logger } from '../utils/logger';

const HOLIDAY_PATH = '/uapi/domestic-stock/v1/quotations/chk-holiday';
const TR_ID = 'CTCA0903R';

interface HolidayRow {
  bass_dt: string; // YYYYMMDD
  opnd_yn: string; // 개장일여부 Y/N
}

interface HolidayResponse {
  rt_cd: string;
  msg1: string;
  output?: HolidayRow[];
}

/** YYYYMMDD → 개장여부(true=개장, false=휴장). 키 없으면 '모름'. */
const openByDate = new Map<string, boolean>();

/** 기준일부터 ~수주치 개장일 정보를 1회 조회 (연속조회는 MVP 생략 — 첫 페이지 24일치로 충분). */
async function fetchHolidays(bassDt: string): Promise<HolidayRow[]> {
  const headers = await kisHeaders(TR_ID);
  const { data } = await axios.get<HolidayResponse>(`${KIS_BASE}${HOLIDAY_PATH}`, {
    headers,
    params: { BASS_DT: bassDt, CTX_AREA_FK: '', CTX_AREA_NK: '' },
    timeout: 10_000,
  });
  // rt_cd '0'이면 정상(연속조회 안내 msg도 '0'으로 옴). output만 취한다.
  if (data.rt_cd !== '0') {
    throw new Error(`KIS 휴장일조회 오류 (${data.rt_cd}): ${data.msg1}`);
  }
  return data.output ?? [];
}

/**
 * 휴장일 캐시 갱신. 오늘(KST) 기준으로 조회해 openByDate에 채운다.
 * 스케줄러가 하루 1회 + 콜드스타트에서 호출. 실패해도 throw하지 않는다(안전 폴백).
 */
export async function refreshHolidayCache(): Promise<void> {
  const today = kstYmd(new Date());
  try {
    const rows = await withRetry(() => fetchHolidays(today));
    let filled = 0;
    for (const r of rows) {
      if (r.bass_dt) {
        openByDate.set(r.bass_dt, r.opnd_yn === 'Y');
        filled++;
      }
    }
    logger.info(`[Holiday] 개장일 캐시 갱신 — ${filled}일치 (기준 ${today})`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`[Holiday] 캐시 갱신 실패(시각판정만으로 동작): ${msg}`);
  }
}

/**
 * 주어진 날짜(KST)가 개장일인지 동기 조회.
 * @returns true=개장 / false=휴장 / **캐시에 없으면 true(개장으로 간주 — 안전 폴백)**
 */
export function isOpenDay(now: Date = new Date()): boolean {
  const ymd = kstYmd(now);
  const cached = openByDate.get(ymd);
  // 캐시 미보유(조회 실패/아직 미갱신) → 개장으로 간주해 정상 수집을 막지 않는다.
  return cached === undefined ? true : cached;
}

/**
 * Price Gap 수집/노출 활성 판정 = 시각창(평일 09:00~15:35) AND 개장일.
 * isPriceGapWindow(시각만, publicCommon)에 개장일 캐시 확인을 더한 통합 판정.
 * 콜드스타트·스케줄러·라우트(marketOpen)에서 이 함수를 쓴다.
 * (publicCommon이 holiday를 import하면 순환참조라, 통합 판정은 여기에 둔다.)
 */
export function isPriceGapActive(now: Date = new Date()): boolean {
  return isPriceGapWindow(now) && isOpenDay(now);
}

/** 캐시 초기화 (테스트용) */
export function resetHolidayCache(): void {
  openByDate.clear();
}
