/** 제거 대상 추적 파라미터 (정확 일치) */
const TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'fbclid',
  'gclid',
  'igshid',
  'spm',
  'cmpid',
  'ref',
  'ref_src',
]);

/**
 * URL을 정규화한다 (중복 비교용 canonical_url 생성).
 * - 추적 파라미터(utm_*, fbclid, gclid 등) 제거
 * - 쿼리 파라미터 정렬로 순서 차이 제거
 * - 끝의 슬래시/fragment 제거, 소문자 호스트
 * 파싱 실패 시 원본 문자열을 그대로 반환한다.
 */
export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());

    u.hash = '';
    u.hostname = u.hostname.toLowerCase();

    // 추적 파라미터 제거 (utm_ 접두어는 전부 제거)
    const keep: [string, string][] = [];
    for (const [k, v] of u.searchParams.entries()) {
      const key = k.toLowerCase();
      if (TRACKING_PARAMS.has(key) || key.startsWith('utm_')) continue;
      keep.push([k, v]);
    }
    keep.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
    u.search = '';
    for (const [k, v] of keep) u.searchParams.append(k, v);

    // 경로 끝 슬래시 제거 (루트 제외)
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
      u.pathname = u.pathname.slice(0, -1);
    }

    return u.toString();
  } catch {
    return raw.trim();
  }
}
