/** 공공데이터 수집 공통 유틸 */

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

/** YYYYMMDD → ISO timestamp (KST 자정 기준) */
export function ymdToIso(ymd: string): string {
  if (!/^\d{8}$/.test(ymd)) return new Date().toISOString();
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}T00:00:00+09:00`;
}
