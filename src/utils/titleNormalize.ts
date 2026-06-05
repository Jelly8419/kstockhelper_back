/**
 * 제거 대상 머리표지 (대괄호/소괄호). 제목 앞/중간 어디든 제거.
 * [속보][단독][특징주][종합] (종합) (2보) (상보) (3보) (1보) (재종합) 등
 */
const TAG_PATTERNS: RegExp[] = [
  /\[(속보|단독|특징주|종합|긴급|확대|기획|인터뷰|일문일답|영상|포토|표|그래픽|fn마켓워치|마켓워치)\]/g,
  /\((종합\d?|\d보|상보|재종합|일문일답|영상|포토)\)/g,
];

/** HTML 엔티티 디코드 (네이버 응답에 포함되는 흔한 엔티티) */
function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

/**
 * 뉴스 제목을 정규화한다.
 * - 네이버 응답의 <b></b> 등 HTML 태그 제거
 * - HTML 엔티티 디코드
 * - [속보][단독][종합] 등 머리표지 제거
 * - 연속 공백 정리, 앞뒤 트림
 */
export function normalizeTitle(raw: string): string {
  let s = raw;
  s = s.replace(/<[^>]+>/g, ''); // HTML 태그 제거
  s = decodeEntities(s);
  for (const re of TAG_PATTERNS) s = s.replace(re, '');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}
