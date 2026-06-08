/** 시장데이터 수집 공통 유틸 */

/** ms 만큼 대기. 한투 API 유량제한(초당 호출수) 회피용 호출 간격에 사용. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 한투 호출 간 기본 간격(ms). 한투 실전 API는 초당 거래건수 제한(EGW00201)이 있어
 * 연속 호출 시 일부가 500으로 떨어진다. 1일 1회·총 5호출이라 지연은 무의미.
 */
export const KIS_CALL_GAP_MS = 500;

/**
 * 한투 유량제한(EGW00201)은 일시적이라 재시도로 거의 해소된다.
 * fn을 호출하고 실패 시 backoff 후 재시도한다.
 * @param fn 실제 호출 (성공값 반환, 실패 시 throw)
 * @param attempts 총 시도 횟수 (기본 3)
 * @param backoffMs 재시도 전 대기 (시도마다 누적 증가)
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  attempts = 3,
  backoffMs = 600,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await sleep(backoffMs * (i + 1));
    }
  }
  throw lastErr;
}

/** KST 기준 YYYYMMDD */
export function kstYmd(d: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}${get('month')}${get('day')}`;
}

/**
 * 조회 기간: 오늘(KST)부터 N일 전까지.
 * 금융위/ECOS 모두 주말·공휴일엔 데이터가 없어, 범위로 조회 후 최신 1건을 취한다.
 */
export function recentRange(days = 10): { begin: string; end: string } {
  const now = new Date();
  const begin = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return { begin: kstYmd(begin), end: kstYmd(now) };
}

/** 문자열 숫자 → number | null (빈값/비정상 안전 처리) */
export function toNum(v: string | undefined | null): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 한투(KIS) 전일대비 부호 보정.
 * prdy_vrss_sign: 1상한 2상승 3보합 4하한 5하락 → 4/5면 음수로 변환.
 * 한투 현재가/지수 API의 전일대비 값이 절댓값으로 오는 경우를 방지한다.
 */
export function applyKisSign(value: number | null, sign: string | undefined): number | null {
  if (value === null) return null;
  // 5=하락, 4=하한 → 하락 방향. 이미 음수면 그대로 둔다.
  const isDown = sign === '4' || sign === '5';
  if (isDown && value > 0) return -value;
  return value;
}

/** YYYYMMDD → ISO timestamp (KST 자정 기준) */
export function ymdToIso(ymd: string): string {
  if (!/^\d{8}$/.test(ymd)) return new Date().toISOString();
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}T00:00:00+09:00`;
}
