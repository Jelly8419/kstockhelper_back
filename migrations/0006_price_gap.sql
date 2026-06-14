-- 0006_price_gap.sql
-- Price Gap Monitor — 1분 갭 OHLC 집계 저장.
--
-- 한국주식 USD 환산 기준가(KR price / USDKRW)와 Binance/Bybit 한국주식 연계
-- 무기한선물 가격의 갭(%)을 1초 단위로 계산하고, 1분 경계에서 OHLC로 집계해 저장한다.
-- 차트(1분 close_gap 실선)의 데이터 소스. 최신값(테이블 표시)은 백엔드 인메모리
-- cache가 source of truth이므로 DB에 두지 않는다(이 테이블은 차트 이력 전용).
--
-- 노출 정책:
--   - 프론트는 백엔드 API(GET /api/price-gap/chart)만 호출. 이 테이블에 직접 접근하지 않는다.
--   - 따라서 anon/authenticated 권한을 주지 않고 service_role 전용으로 둔다(백엔드가 읽어 가공).
--   - Basic 10분 지연은 백엔드 API가 timestamp_minute <= now()-10m 컷으로 적용한다(뷰 불필요).
--
-- 실행: Supabase SQL Editor에서 전체 실행. 모든 구문이 멱등(재실행 안전)하다.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) price_gap_ohlc (1분 갭 OHLC)
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.price_gap_ohlc (
  id               bigint generated always as identity primary key,
  timestamp_minute timestamptz not null,                 -- 분 경계 (UTC 저장)
  stock_code       text not null,                        -- '005930'
  stock_name       text not null,                        -- '삼성전자'
  exchange         text not null
                     check (exchange in ('binance', 'bybit')),
  open_gap         double precision not null,            -- 해당 1분 구간 첫 gap%
  high_gap         double precision not null,            -- 최고 gap%
  low_gap          double precision not null,            -- 최저 gap%
  close_gap        double precision not null,            -- 마지막 gap% (차트 라인 기준)
  avg_gap          double precision,                     -- 평균 gap% (저장만, MVP 차트 미사용)
  created_at       timestamptz not null default now(),
  -- 서버 재시작 시 같은 분을 다시 flush해도 중복되지 않도록 (upsert 멱등 키)
  unique (timestamp_minute, stock_code, exchange)
);

-- 차트 조회: (종목, 거래소) 필터 + 분 내림차순 (최근 구간 우선)
create index if not exists price_gap_ohlc_lookup_idx
  on public.price_gap_ohlc (stock_code, exchange, timestamp_minute desc);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) 권한 — 백엔드(service_role) 전용
-- ─────────────────────────────────────────────────────────────────────────────
-- 프론트는 백엔드 API 경유로만 차트를 읽으므로 anon/authenticated 권한을 주지 않는다.
grant select, insert on public.price_gap_ohlc to service_role;

-- IDENTITY 시퀀스 권한 (service_role insert 시 id 채번). 0005에서 이미 부여했으나 멱등 재보장.
grant usage, select on all sequences in schema public to service_role;

-- 주의
-- - 이 테이블은 차트 이력 전용. 최신 스냅샷(테이블 UI)은 백엔드 인메모리 cache가 담당.
-- - avg_gap은 향후 normal range/deviation 통계용으로 저장만 한다(MVP 차트는 close_gap 사용).
-- - 1초 raw tick은 저장하지 않는다(PRD §17: 단기 인메모리 buffer로만 보관).
