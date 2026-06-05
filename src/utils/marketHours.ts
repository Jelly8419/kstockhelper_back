/**
 * 한국 증시 운영시간 판단.
 * 평일(월~금) 09:00 ~ 15:35 KST 사이에만 true.
 * (공휴일 휴장은 고려하지 않음 — 휴장일에도 Yahoo 값은 변하지 않으므로 upsert 결과 영향 없음)
 */
export function isMarketOpen(now: Date = new Date()): boolean {
  // KST(Asia/Seoul) 기준 요일/시/분 추출
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';

  const weekday = get('weekday'); // Mon, Tue, ...
  let hour = Number(get('hour'));
  const minute = Number(get('minute'));

  // Intl이 자정을 '24'로 줄 수 있어 보정
  if (hour === 24) hour = 0;

  const isWeekday = !['Sat', 'Sun'].includes(weekday);
  if (!isWeekday) return false;

  const minutesOfDay = hour * 60 + minute;
  const open = 9 * 60; // 09:00
  const close = 15 * 60 + 35; // 15:35

  return minutesOfDay >= open && minutesOfDay <= close;
}
