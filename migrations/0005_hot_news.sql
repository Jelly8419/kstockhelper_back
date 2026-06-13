-- 0005_hot_news.sql
-- Korean's Hot News (관리자 직접 등록 + 예약 게시, 프리미엄 전용)
--
-- 자동 수집 뉴스(news)와 별도 도메인. 관리자가 한국어로 title/content를 입력하면
-- 백엔드가 generateNewsBrief(sonnet)로 영문 가공본(translated_title/summary/key_points)을
-- 만들어 저장하고, 게시 시점에 5개 언어(vi/ru/pt-BR/hi/uk)를 선제 번역한다.
-- 번역 구조/권한 모델은 기존 news / news_translations 와 동일하게 맞춘다.
--
-- 노출 정책:
--   - Lazy 전환 뷰(hot_news_public): status='published' 이거나
--     (status='scheduled' AND scheduled_at<=now()) 인 행만 노출. 별도 배치 없이도
--     예약 시간 도달분이 즉시 보인다.
--   - node-cron 배치가 실제 scheduled→published 전환 + published_at 기록 + 예약 시점
--     번역을 수행한다(이중 안전망). 배치가 늦거나 실패해도 뷰가 노출을 보장한다.
--   - 프리미엄 게이트는 뷰에서 is_premium()으로 DB 레벨 차단(일반 뉴스 news_full과 동일).
--     비프리미엄/anon에게는 content 등 본문 필드가 null로 내려간다.
--
-- 실행: Supabase SQL Editor에서 전체 실행. 모든 구문이 멱등(재실행 안전)하다.
-- 전제: 기존 is_premium() 함수가 존재한다(news_full 뷰가 사용 중인 동일 함수 재사용).

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) hot_news (원본 테이블)
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.hot_news (
  id               uuid primary key default gen_random_uuid(),
  seq_id           bigint generated always as identity,  -- URL 표면용 짧은 정수
  -- 관리자 입력(한국어 원문)
  title            text not null,
  content          text not null,
  -- generateNewsBrief 산출(영문 가공본). hidden으로 처음 저장 시 비어있을 수 있고,
  -- published/scheduled 전환 시 채워진다.
  translated_title text,
  summary          text,
  key_points       jsonb,                                -- string[]
  slug             text,                                 -- buildSlug(translated_title)
  -- 관련 종목 (복수 선택). 값은 stocks.id 슬러그: 'samsung' | 'skhynix' | 'hyundai'
  stock_ids        text[] not null default '{}',
  status           text not null default 'hidden'
                     check (status in ('scheduled', 'published', 'hidden')),
  scheduled_at     timestamptz,                          -- status='scheduled'일 때 필수(앱 검증)
  published_at     timestamptz,                          -- 최초 published 전환 시각
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- seq_id 단건 조회/유니크
create unique index if not exists hot_news_seq_id_key on public.hot_news (seq_id);
-- 노출 뷰 필터(상태 + 예약시각) 가속
create index if not exists hot_news_status_sched_idx
  on public.hot_news (status, scheduled_at);

-- updated_at 자동 갱신 트리거
create or replace function public.fn_hot_news_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists trg_hot_news_touch on public.hot_news;
create trigger trg_hot_news_touch
  before update on public.hot_news
  for each row execute function public.fn_hot_news_touch_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) hot_news_translations (선제 번역 캐시) — news_translations와 동일 구조
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.hot_news_translations (
  hot_news_id      uuid not null references public.hot_news(id) on delete cascade,
  locale           text not null check (locale in ('vi', 'ru', 'pt-BR', 'hi', 'uk')),
  translated_title text,
  summary          text,
  key_points       jsonb,                                -- string[]
  created_at       timestamptz not null default now(),
  primary key (hot_news_id, locale)
);

create index if not exists hot_news_translations_hot_news_id_idx
  on public.hot_news_translations (hot_news_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3a) 노출용 뷰 hot_news_public (Lazy 전환 + 프리미엄 본문 차단)
-- ─────────────────────────────────────────────────────────────────────────────
-- 컬럼 구성 변경에 안전하도록 drop 후 재생성.
drop view if exists public.hot_news_public;

create view public.hot_news_public as
select
  h.id,
  h.seq_id,
  coalesce(h.translated_title, h.title) as title,
  h.slug,
  h.stock_ids,
  -- 노출 게시일: 실제 전환됐으면 published_at, 아니면(due-scheduled) scheduled_at
  coalesce(h.published_at, h.scheduled_at) as published_at,
  h.created_at,
  -- 본문/요약/핵심은 프리미엄에게만. 비프리미엄/anon에게는 null (일반 뉴스 news_full과 동일 정책).
  case when is_premium() then h.content     else null::text   end as content,
  case when is_premium() then h.summary     else null::text   end as summary,
  case when is_premium() then h.key_points  else null::jsonb  end as key_points
from public.hot_news h
where
  h.status = 'published'
  or (h.status = 'scheduled' and h.scheduled_at <= now());

-- ─────────────────────────────────────────────────────────────────────────────
-- 3b) 번역 노출 뷰 hot_news_translations_public (프리미엄 번역 본문 차단)
-- ─────────────────────────────────────────────────────────────────────────────
-- 번역 원본 테이블(hot_news_translations)은 anon에 열지 않는다. 대신 이 뷰로:
--   - 노출 대상(published or due-scheduled) 기사의 번역만 (미게시 기사 번역 누출 방지)
--   - translated_title은 목록 표시용이라 항상 노출, summary/key_points 본문은 is_premium()만.
-- 본문 보호 정책을 hot_news_public과 동일하게 맞춘다.
drop view if exists public.hot_news_translations_public;

create view public.hot_news_translations_public as
select
  t.hot_news_id,
  t.locale,
  t.translated_title,
  case when is_premium() then t.summary    else null::text  end as summary,
  case when is_premium() then t.key_points else null::jsonb end as key_points
from public.hot_news_translations t
join public.hot_news h on h.id = t.hot_news_id
where
  h.status = 'published'
  or (h.status = 'scheduled' and h.scheduled_at <= now());

-- ─────────────────────────────────────────────────────────────────────────────
-- 4) 권한
-- ─────────────────────────────────────────────────────────────────────────────
-- 원본 테이블 2개: 백엔드(service_role) 전용. anon 직접 접근 차단.
grant select, insert, update, delete on public.hot_news to service_role;
grant select, insert, update, delete on public.hot_news_translations to service_role;

-- 노출 뷰 2개만 anon/authenticated 읽기. 본문 차단은 뷰의 is_premium()이 담당.
grant select on public.hot_news_public to anon, authenticated, service_role;
grant select on public.hot_news_translations_public to anon, authenticated, service_role;

-- IDENTITY 시퀀스 권한 (service_role insert 시 seq_id 채번)
grant usage, select on all sequences in schema public to service_role;

-- 주의
-- - 원본 테이블(hot_news, hot_news_translations)은 anon에 노출하지 않는다.
--   프론트는 노출 뷰(hot_news_public, hot_news_translations_public)만 SELECT.
-- - 번역 본문(summary/key_points)도 원본과 동일하게 is_premium()으로 차단된다.
--   translated_title은 목록 표시용이라 노출(제목 자체는 비민감).
-- - 원문(title/content) 수정 시 기존 번역은 재생성하지 않는다(MVP: 한 번 번역 고정).
--   재번역이 필요하면 해당 (hot_news_id, locale) 행을 delete 후 재생성한다.
