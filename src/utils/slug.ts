/**
 * SEO URL용 slug 생성 (PRD §5: 뉴스/공시 상세 URL의 slug 규칙).
 *
 * slug는 영어 제목(translated_title) 기준으로 만든다:
 *   - 소문자화
 *   - 영숫자가 아닌 모든 문자는 하이픈으로 변환
 *   - 연속/양끝 하이픈 정리
 *   - 너무 긴 제목은 단어 경계에서 적절히 축약
 *
 * news_id / disclosure_id 접두는 붙이지 않는다.
 * 최종 URL(`/{locale}/news/{id}-{slug}`)에서 id는 프론트가 별도로 부착하며,
 * slug는 표시/SEO 용도다 (라우팅 키는 항상 id).
 */

/** slug 최대 길이 (하이픈 포함). 너무 길면 단어 경계에서 자른다. */
const MAX_SLUG_LENGTH = 80;

/**
 * 영어 제목을 URL slug로 변환한다.
 * 영숫자가 하나도 없으면(예: 제목이 비영문뿐이거나 빈 문자열) 빈 문자열을 반환한다.
 * 호출 측은 빈 결과를 "slug 없음"으로 처리한다 (DB에는 null 저장).
 */
export function slugify(title: string): string {
  const base = title
    .toLowerCase()
    .normalize('NFKD') // 분음 부호 분리 (é → e + combining mark)
    .replace(/[̀-ͯ]/g, '') // combining diacritical marks 제거
    .replace(/[^a-z0-9]+/g, '-') // 영숫자 외 → 하이픈
    .replace(/^-+|-+$/g, ''); // 양끝 하이픈 제거

  if (base.length <= MAX_SLUG_LENGTH) return base;

  // 길이 초과 시 MAX 안쪽 마지막 하이픈에서 잘라 단어가 잘리지 않게 한다.
  const cut = base.slice(0, MAX_SLUG_LENGTH);
  const lastHyphen = cut.lastIndexOf('-');
  return lastHyphen > 0 ? cut.slice(0, lastHyphen) : cut;
}

/**
 * 제목으로부터 DB 저장용 slug 값을 만든다.
 * 유효한 slug가 없으면 null을 반환한다 (컬럼은 nullable, 프론트가 런타임 fallback).
 */
export function buildSlug(title: string | null | undefined): string | null {
  if (!title) return null;
  const s = slugify(title);
  return s.length > 0 ? s : null;
}
