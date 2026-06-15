-- 0009_price_gap_ohlc_grant_update.sql
-- price_gap_ohlc 에 service_role UPDATE 권한 부여 (upsert 동작 복구).
--
-- 배경:
--   0006에서 price_gap_ohlc 에 service_role 'select, insert'만 부여했다.
--   그러나 OHLC flush는 upsert(.upsert(row, { onConflict: ... }))를 사용한다.
--   PostgREST의 upsert는 'INSERT ... ON CONFLICT DO UPDATE' 문을 발행하는데,
--   PostgreSQL은 실행 전 권한을 검사하므로 UPDATE 권한이 없으면
--   충돌 여부와 무관하게 'permission denied for table price_gap_ohlc'로 거부한다.
--
--   증상: 매 분 flush 마다 로그에 'price_gap_ohlc 저장 실패: permission denied' 발생,
--         OHLC 1분봉이 전혀 저장되지 않음(차트 데이터 누락).
--
-- 수정: service_role 에 UPDATE 권한을 추가한다. (재시작 후 같은 분 재flush 멱등성은
--       unique(timestamp_minute, stock_code, exchange) + ON CONFLICT DO UPDATE로 보장됨)
--
-- 실행: Supabase SQL Editor에서 전체 실행. 멱등(재실행 안전).

grant update on public.price_gap_ohlc to service_role;

-- 전체 권한 명시적 재확인(문서화 + 멱등 보장).
grant select, insert, update on public.price_gap_ohlc to service_role;
