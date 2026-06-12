-- 0003_news_slug.sql
-- 뉴스/공시 상세 URL용 slug 컬럼 (PRD: 뉴스/공시 상세페이지 URL 및 SEO 수정)
--
-- 상세 URL 구조는 `/{locale}/news/{news_id}-{slug}` 형태이며, slug는 영문 제목
-- (translated_title) 기반으로 생성한다. 라우팅 키는 항상 id이고 slug는 SEO/표시용이라,
-- slug가 null이거나 불일치해도 프론트는 id로 서빙하고 canonical로 정확 URL을 지시한다.
--
-- 정책 (옵션 B): slug는 publish 시점에 백엔드가 translated_title을 slugify해 news.slug에
--               한 번 저장하고 고정한다 (원문 제목이 바뀌어도 URL 영속성을 위해 재생성 안 함).
--               프론트는 news_preview/news_full 뷰에서 slug를 직접 SELECT한다.
--
-- 실행: Supabase SQL Editor에서 전체 실행. 모든 구문이 멱등(재실행 안전)하다.

-- 1) news 테이블에 slug 컬럼 추가 (nullable: 비영문 제목 등은 slug가 없을 수 있음)
alter table public.news
  add column if not exists slug text;

-- slug로 직접 조회하지는 않지만(라우팅 키는 id), 운영/디버깅 시 lookup 대비 인덱스.
-- 부분 인덱스로 slug가 있는 행만 색인해 크기를 줄인다.
create index if not exists news_slug_idx on public.news (slug) where slug is not null;

-- 2) news_preview / news_full 뷰에 slug 노출
--    create or replace는 컬럼 추가가 제한적이라 drop 후 재생성한다.
--    (뷰는 published 행만/preview는 비프리미엄 안전 필드만 노출하므로 anon select가 안전)

drop view if exists public.news_preview;
drop view if exists public.news_full;

create view public.news_full as
select
  n.id,
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

-- 3) 뷰 권한 재부여 (drop으로 사라진 grant 복구)
--    프론트(anon)는 두 뷰를 직접 SELECT한다. news_translations와 동일한 읽기 모델.
grant select on public.news_preview to anon, authenticated, service_role;
grant select on public.news_full to anon, authenticated, service_role;

-- 주의
-- - slug는 publish 시 1회 확정·고정한다. 원문 제목 수정으로 재번역해도 slug는 그대로 둔다
--   (이미 색인/공유된 URL의 영속성 보호). 강제 재생성이 필요하면 해당 행 slug를 null로
--   비운 뒤 백필 스크립트(scripts/backfillSlug.ts)를 재실행한다.
-- - slug 불일치 URL도 프론트가 id 기준으로 200 서빙하며 canonical로 정확 URL을 지시한다.
