/**
 * Claude 번역/요약 대상 DART 공시 유형 (report_nm 기준, 21개).
 * 이 목록에 포함된 공시만 번역 파이프라인을 태운다.
 * 그 외 유형은 수집만 하고 disclosure_type_unconfirmed 로그 후 스킵.
 */
export const PUBLISHABLE_DISCLOSURE_TYPES = new Set<string>([
  '연결재무제표기준영업(잠정)실적(공정공시)',
  '영업(잠정)실적(공정공시)',
  '장래사업ㆍ경영계획(공정공시)',
  '기업가치제고계획(자율공시)',
  '신규시설투자등',
  '유형자산취득결정',
  '현금ㆍ현물배당결정',
  '주요사항보고서(자기주식취득결정)',
  '주요사항보고서(자기주식처분결정)',
  '주식소각결정',
  '주식등의대량보유상황보고서(일반)',
  '주식등의대량보유상황보고서(약식)',
  '최대주주등소유주식변동신고서',
  '타법인주식및출자증권취득결정',
  '타법인주식및출자증권취득결정(자율공시)',
  '유상증자결정(종속회사의주요경영사항)',
  '영업양수결정(종속회사의주요경영사항)',
  '영업양도결정(종속회사의주요경영사항)',
  '파생상품거래손실발생',
  '조회공시요구(풍문또는보도)에대한답변(미확정)',
  '풍문또는보도에대한해명(미확정)',
]);

/**
 * report_nm에서 정정 접두어를 제거해 기준 유형으로 정규화한다.
 * 예: "[기재정정]현금ㆍ현물배당결정" → "현금ㆍ현물배당결정"
 * 후행 공백(DART 응답에 종종 포함)도 제거한다.
 */
export function normalizeReportName(reportNm: string): string {
  return reportNm.replace(/^\[[^\]]*정정\]/, '').trim();
}

/**
 * 해당 공시가 번역 대상인지 판정한다.
 * 1) 정확 매칭 우선
 * 2) report_nm 뒤에 부가설명이 붙는 경우 처리
 *    예: "기업가치제고계획(자율공시)              (2025년 이행현황)"
 *    → 등록 유형이 정규화된 report_nm의 prefix이면 매칭
 *    (단, prefix 뒤는 공백 또는 '('로 이어져야 함 — 다른 유형 오매칭 방지)
 */
export function isPublishableDisclosure(reportNm: string): boolean {
  const normalized = normalizeReportName(reportNm);
  if (PUBLISHABLE_DISCLOSURE_TYPES.has(normalized)) return true;

  for (const type of PUBLISHABLE_DISCLOSURE_TYPES) {
    if (normalized.startsWith(type)) {
      const rest = normalized.slice(type.length);
      if (rest === '' || /^[\s(]/.test(rest)) return true;
    }
  }
  return false;
}
