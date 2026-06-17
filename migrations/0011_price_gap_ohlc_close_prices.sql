-- ─────────────────────────────────────────────────────────────────────────────
-- 0011 price_gap_ohlc 종료 시점 원시가격 컬럼 추가
-- ─────────────────────────────────────────────────────────────────────────────
-- 배경: price_gap_ohlc는 gap%(open/high/low/close)만 저장하고 원시가격은 보관하지
-- 않았다. 그래서 장 마감 후 서버 재배포 시 /latest 폴백이 gap만 복원하고
-- KR Price / Reference / Exchange Price는 null로 내려갔다(테이블 '—').
--
-- 이 마이그레이션은 분봉 close 시점의 원시가격 3종을 추가해, 재배포 폴백에서도
-- 가격을 복원할 수 있게 한다. nullable — 기존 행과 gap만 있는 백필분은 null로 둔다.
--   close_kr_price  : 원화 체결가 (KR Price)
--   close_usd_ref   : USD Reference (= krPrice / usdtKrw)
--   close_ex_price  : perp 가격 USDT (Binance/Bybit Price)
--
-- 차트(/chart)는 close_gap만 쓰므로 영향 없음.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.price_gap_ohlc
  add column if not exists close_kr_price double precision,
  add column if not exists close_usd_ref double precision,
  add column if not exists close_ex_price double precision;
