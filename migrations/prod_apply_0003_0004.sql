-- prod_apply_0003_0004.sql
-- 운영 DB 일괄 적용용 통합 마이그레이션 (0003 slug + 0004 seq_id).
--
-- 목적: Supabase SQL Editor에 한 번 붙여넣어 slug 컬럼 + seq_id 컬럼 + 두 뷰 재정의를
--       원자적으로 적용한다. 전체를 BEGIN/COMMIT으로 감싸 뷰 drop~recreate 구간이
--       외부(프론트 anon 조회)에 빈 상태로 노출되지 않게 한다.
--
-- 안전성:
--   - 전부 멱등(재실행 안전). 이미 일부 적용된 환경에서도 깨지지 않는다.
--   - 실패 시 COMMIT 전이면 트랜잭션이 통째로 롤백된다.
--
-- 적용 후: slug는 자동 백필되지 않으므로, 운영 서버에서 백필 스크립트를 1회 실행한다.
--   npx tsx scripts/backfillSlug.ts --dry-run   # 미리보기
--   npx tsx scripts/backfillSlug.ts             # 실제 백필
-- (seq_id는 IDENTITY라 컬럼 추가 시 자동 백필 — 스크립트 불필요)

begin;

-- ===== 1) slug 컬럼 + 인덱스 (0003) =====
alter table public.news
  add column if not exists slug text;

-- slug lookup 대비 부분 인덱스 (slug 있는 행만 색인)
create index if not exists news_slug_idx on public.news (slug) where slug is not null;

-- ===== 2) seq_id 컬럼 + 유니크 인덱스 (0004) =====
-- GENERATED ALWAYS AS IDENTITY: add column 시 기존 행에 순차값 자동 백필.
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

alter table public.news
  alter column seq_id set not null;

-- seq_id 단건 조회(.eq("seq_id", N)) 고속 + 유니크 제약
create unique index if not exists news_seq_id_key on public.news (seq_id);

-- ===== 3) 뷰 재정의 (slug + seq_id 둘 다 노출) =====
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

-- ===== 4) 뷰 권한 재부여 =====
grant select on public.news_preview to anon, authenticated, service_role;
grant select on public.news_full to anon, authenticated, service_role;

commit;

-- ===== 적용 검증 (별도 실행 권장) =====
-- select count(*) total, count(seq_id) seq_filled, count(slug) slug_filled from public.news;
-- select id, seq_id, slug, title from public.news_full order by seq_id limit 1;
