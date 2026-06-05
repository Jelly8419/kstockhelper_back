/**
 * 텍스트 유사도 (0~1). 문자 bigram 기반 Dice 계수.
 * 한국어/영문/숫자 혼용 짧은 텍스트(제목·snippet)에 적합하다.
 */

/** 비교 전 정규화: 소문자화, HTML 태그 제거, 영숫자/한글 외 제거, 공백 압축 */
function canonicalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[^0-9a-z가-힣\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 문자 bigram 멀티셋 생성 (공백 제거 후) */
function bigrams(s: string): Map<string, number> {
  const compact = s.replace(/\s/g, '');
  const map = new Map<string, number>();
  for (let i = 0; i < compact.length - 1; i++) {
    const bg = compact.slice(i, i + 2);
    map.set(bg, (map.get(bg) ?? 0) + 1);
  }
  return map;
}

/**
 * Dice 계수 유사도 (0~1).
 * 두 문자열이 동일하면 1, 공통 bigram이 없으면 0.
 */
export function similarity(a: string, b: string): number {
  const ca = canonicalize(a);
  const cb = canonicalize(b);
  if (!ca || !cb) return 0;
  if (ca === cb) return 1;

  const ba = bigrams(ca);
  const bb = bigrams(cb);
  if (ba.size === 0 || bb.size === 0) return 0;

  let intersection = 0;
  for (const [bg, countA] of ba.entries()) {
    const countB = bb.get(bg);
    if (countB) intersection += Math.min(countA, countB);
  }

  const totalA = [...ba.values()].reduce((s, n) => s + n, 0);
  const totalB = [...bb.values()].reduce((s, n) => s + n, 0);
  return (2 * intersection) / (totalA + totalB);
}
