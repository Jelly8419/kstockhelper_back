-- 0004_news_seq_id.sql
-- 뉴스/공시 상세 URL용 짧은 숫자 ID (seq_id)
--
-- 상세 URL은 `/{locale}/news/{seq_id}-{slug}` 형태가 된다. 기존 UUID(id)는 길고
-- URL에 노출하기 부적합하므로, URL 표면용으로 짧고 안정적인 순차 정수를 추가한다.
--
-- 정책:
--   - 내부 조인/번역(news_translations 등)은 계속 UUID(id)를 PK로 사용한다.
--     seq_id는 오직 URL 표면 + 상세 조회 필터용이다.
--   - GENERATED ALWAYS AS IDENTITY: 기존 행도 추가 시점에 자동으로 순차값이 채워진다
--     (물리 행 순서 기준 — 요청상 "임의 순서 OK"라 별도 백필 스크립트 불필요).
--   - 신규 insert 시 자동 증가하므로 collector/seed 코드 변경 불필요.
--
-- 전제: 0003_news_slug.sql(slug 컬럼 + 뷰)이 선행된다. 다만 이 마이그레이션은
--       slug 컬럼도 `if not exists`로 보장하고 뷰를 slug+seq_id로 재정의하므로
--       0003 적용 여부와 무관하게 단독 실행해도 안전하다 (전부 멱등).
--
-- 실행: Supabase SQL Editor에서 전체 실행. 모든 구문이 멱등(재실행 안전)하다.

-- 1) slug 컬럼 보장 (0003 미적용 환경에서도 아래 뷰 재정의가 깨지지 않도록)
alter table public.news
  add column if not exists slug text;

-- 2) seq_id 컬럼 추가 (bigint, auto-increment, NOT NULL, UNIQUE)
--    GENERATED ALWAYS AS IDENTITY는 add column 시 기존 행에도 순차값을 채운다.
--    이미 존재하면(재실행) 건너뛴다.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'news' and column_name = 'seq_id'
  ) then
    alter table public.news
      add column seq_id bigint generated always as identity;
  end if;
end $$;

-- NOT NULL 보장 (IDENTITY는 기본 NOT NULL이지만 멱등성을 위해 명시)
alter table public.news
  alter column seq_id set not null;

-- 유니크 인덱스 = seq_id 단건 조회(.eq("seq_id", N)) 고속 + 유니크 제약
create unique index if not exists news_seq_id_key on public.news (seq_id);

-- 3) news_preview / news_full 뷰에 seq_id(+slug) 노출
--    create or replace는 컬럼 추가가 제한적이라 drop 후 재생성한다.
drop view if exists public.news_preview;
drop view if exists public.news_full;

create view public.news_full as
select
  n.id,
  n.seq_id,
  n.category,
  n.subcategory,
  COALESCE(n.translated_title, n.title) as title,
  "left" (COALESCE(n.summary, ''::text), 280) as preview,
  n.slug,
  n.source,
  n.url,
  n.is_premium,
  n.published_at,
  case
    when is_premium () then n.english_translation
    else null::text
  end as body,
  case
    when is_premium () then n.summary
    else null::text
  end as summary,
  case
    when is_premium () then n.key_points
    else null::text[]
  end as key_points,
  case
    when is_premium () then n.key_figures
    else null::jsonb
  end as key_figures,
  COALESCE(
    array_agg(ns.stock_id) filter (
      where
        ns.stock_id is not null
    ),
    '{}'::text[]
  ) as stock_ids
from
  news n
  left join news_stocks ns on ns.news_id = n.id
where
  n.status = 'published'::text
group by
  n.id;

create view public.news_preview as
select
  n.id,
  n.seq_id,
  n.category,
  n.subcategory,
  COALESCE(n.translated_title, n.title) as title,
  "left" (COALESCE(n.summary, ''::text), 280) as preview,
  n.slug,
  n.source,
  n.url,
  n.is_premium,
  n.published_at,
  COALESCE(
    array_agg(ns.stock_id) filter (
      where
        ns.stock_id is not null
    ),
    '{}'::text[]
  ) as stock_ids
from
  news n
  left join news_stocks ns on ns.news_id = n.id
where
  n.status = 'published'::text
group by
  n.id;

-- 4) 뷰 권한 재부여 (drop으로 사라진 grant 복구)
grant select on public.news_preview to anon, authenticated, service_role;
grant select on public.news_full to anon, authenticated, service_role;

-- 주의
-- - seq_id는 URL 표면/조회용이다. 내부 조인·번역은 계속 UUID(id)를 사용한다.
-- - 뷰는 published 행만 노출하므로, 프론트가 news_full을 seq_id로 필터해도
--   미게시 건은 보이지 않는다 (단건 반환은 seq_id UNIQUE로 보장).
