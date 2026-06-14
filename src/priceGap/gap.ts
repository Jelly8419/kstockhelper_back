/**
 * Price Gap Monitor — 갭 계산 (순수 함수, 부수효과 없음).
 *
 *   USD Reference = KR price / (USDT/KRW)
 *   Gap %         = (Exchange Price - USD Reference) / USD Reference * 100
 *
 * 분모는 은행 USD/KRW가 아니라 USDT/KRW(한국 시장 USDT 원화가)다. perp 가격이
 * USDT 기준이라 분모도 USDT 단위여야 같은 단위로 비교된다(fxFeed.ts 참조).
 * 입력 중 하나라도 누락(null)이거나 분모가 0이면 gap=null로 방어한다.
 * 단위테스트 대상(외부 의존 0).
 */

/** USD(T) 기준가: 원화 체결가를 USDT/KRW로 나눈 값. 입력 누락/0이면 null. */
export function computeUsdRef(krPrice: number | null, usdtKrw: number | null): number | null {
  if (krPrice === null || usdtKrw === null) return null;
  if (!Number.isFinite(krPrice) || !Number.isFinite(usdtKrw)) return null;
  if (usdtKrw <= 0) return null;
  return krPrice / usdtKrw;
}

/** 갭 %: (거래소가 - USD기준가) / USD기준가 * 100. 입력 누락/분모0이면 null. */
export function computeGapPercent(exPrice: number | null, usdRef: number | null): number | null {
  if (exPrice === null || usdRef === null) return null;
  if (!Number.isFinite(exPrice) || !Number.isFinite(usdRef)) return null;
  if (usdRef <= 0) return null;
  return ((exPrice - usdRef) / usdRef) * 100;
}

/**
 * 한 (종목×거래소) 조합의 갭 일괄 계산.
 * @returns { usdRef, gap } — 계산 불가 입력은 각각 null.
 */
export function computeGap(
  krPrice: number | null,
  usdtKrw: number | null,
  exPrice: number | null,
): { usdRef: number | null; gap: number | null } {
  const usdRef = computeUsdRef(krPrice, usdtKrw);
  const gap = computeGapPercent(exPrice, usdRef);
  return { usdRef, gap };
}
