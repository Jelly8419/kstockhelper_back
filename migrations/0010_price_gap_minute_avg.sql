-- 0010_price_gap_minute_avg.sql
-- Price Gap Monitor — 분당 평균 갭 사전집계 테이블.
--
-- 배경:
--   프론트 개선안에 두 종류의 "과거 평균"이 추가됐다.
--     1) 테이블 Past Avg Gap  — 전체 과거(All) 기준 "현재 분(minute_of_day)"의 close_gap 평균
--     2) 차트 평균선(avgGap)  — 선택 Period(3/5/10/20/30D) 기준 같은 분 close_gap 평균
--   둘 다 price_gap_ohlc(1분봉 이력)에서 (종목×거래소×분×기간)별로 close_gap을 평균낸 값이다.
--
-- 왜 사전집계인가:
--   /latest는 매 폴링마다 종목×거래소(현재 6) 조합의 평균이 필요하고, /chart는 분(~387)×period까지
--   곱해진다. 매 요청 실시간 집계는 무겁다. 장 마감 후 1회 집계해 이 테이블에 적재하고,
--   API는 이 테이블만 읽는다(빠른 조회 + DB 부하 차단).
--
-- 노출 정책 (0006과 동일):
--   프론트는 백엔드 API 경유로만 읽으므로 anon/authenticated 권한을 주지 않고 service_role 전용.
--
-- 실행: Supabase SQL Editor에서 전체 실행. 모든 구문이 멱등(재실행 안전).

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) price_gap_minute_avg (분당 평균 갭 사전집계)
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.price_gap_minute_avg (
  id             bigint generated always as identity primary key,
  stock_code     text not null,                          -- '005930'
  exchange       text not null
                   check (exchange in ('binance', 'bybit')),
  -- KST 기준 분(minute of day) = hour*60 + minute. 장중 09:00~15:35 = 540~935.
  minute_of_day  smallint not null
                   check (minute_of_day between 0 and 1439),
  -- 집계 기간(거래일). 0 = 전체 과거(All, 테이블 Past Avg용). 3/5/10/20/30 = 차트 평균선용.
  period         smallint not null
                   check (period in (0, 3, 5, 10, 20, 30)),
  avg_close_gap  double precision not null,               -- 해당 (분,기간)의 close_gap 평균(%)
  -- 실제 평균에 사용된 distinct 거래일 수. period보다 적으면 프론트 "available data only" 안내용.
  available_days smallint not null,
  updated_at     timestamptz not null default now(),
  -- (종목, 거래소, 분, 기간) 당 1행 — 집계 재실행 시 upsert 멱등 키
  unique (stock_code, exchange, minute_of_day, period)
);

-- 조회 패턴:
--   /latest : (stock_code, exchange, period=0) 에서 현재 분 1건씩
--   /chart  : (stock_code, exchange, period=N) 의 분 오름차순 전체
-- 두 경우 모두 아래 복합 인덱스로 커버된다.
create index if not exists price_gap_minute_avg_lookup_idx
  on public.price_gap_minute_avg (stock_code, exchange, period, minute_of_day);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) 권한 — 백엔드(service_role) 전용 (0006 패턴)
-- ─────────────────────────────────────────────────────────────────────────────
grant select, insert, update on public.price_gap_minute_avg to service_role;

-- IDENTITY 시퀀스 권한 (service_role insert 시 id 채번). 멱등 재보장.
grant usage, select on all sequences in schema public to service_role;

-- 주의
-- - 이 테이블은 "사전집계 결과" 전용. 원본은 price_gap_ohlc(close_gap)다.
-- - minute_of_day는 KST 분. price_gap_ohlc.timestamp_minute(UTC)를 집계 시 KST로 변환해 채운다.
-- - period=0(All)은 백필 전체 기간 누적이라 available_days가 가장 크다.
