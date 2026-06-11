-- 0002_news_translations.sql
-- 뉴스/공시 콘텐츠 다국어 번역 (PRD: 콘텐츠 번역 정책)
--
-- 영문으로 가공된 콘텐츠(translated_title, summary, key_points)를 각 언어로
-- 번역해 저장한다. en은 news 본체가 이미 영문이라 저장하지 않으며,
-- 화이트리스트(vi, ru, pt-BR, hi, uk) 외 locale은 영문 fallback이라 저장하지 않는다.
--
-- 생성 시점: 뉴스/공시가 게시(published)되는 즉시 백엔드가 5개 언어를 선제 번역해 upsert한다.
--            (collector의 publish 직후 pretranslateNews 호출)
--            프론트는 이 테이블을 Supabase에서 직접 SELECT해서 가져간다.
--            드물게 누락된 (news_id, locale)은 POST /api/news/:id/translate가 lazy 보강한다.
--
-- 실행: Supabase SQL Editor에서 전체 실행. 모든 구문이 멱등(재실행 안전)하다.

create table if not exists news_translations (
  news_id          uuid not null references news(id) on delete cascade,
  locale           text not null check (locale in ('vi', 'ru', 'pt-BR', 'hi', 'uk')),
  translated_title text,
  summary          text,
  key_points       jsonb,           -- string[]
  created_at       timestamptz not null default now(),
  primary key (news_id, locale)     -- (news_id, locale) 단위 캐시 1행
);

-- 특정 기사의 번역 일괄 조회용 (news_id 단독 조회)
create index if not exists news_translations_news_id_idx on news_translations (news_id);

-- 권한 모델 (다른 테이블은 service_role 전용이지만, 이 테이블은 anon 읽기도 연다):
--   service_role(백엔드): 선제 번역 생성/저장 + lazy 보강 (읽기/쓰기 전부)
--   anon(프론트): 읽기만. 선제 번역으로 미리 채워두므로 프론트는 백엔드 API 없이
--                 Supabase에서 news_translations를 직접 SELECT해서 가져간다.
--   번역은 게시(published)된 뉴스에만 생성되므로 anon 전체 SELECT가 민감정보를 노출하지 않는다.
grant select, insert, update, delete on public.news_translations to service_role;
grant select on public.news_translations to anon;       -- 프론트 직접 조회용
alter table public.news_translations disable row level security;

-- 주의
-- - en / 화이트리스트 밖 locale은 이 테이블에 저장하지 않는다 (영문 fallback).
-- - 원문(news.summary 등) 수정 시 기존 번역은 재생성하지 않는다 (MVP: 한 번 번역하면 고정).
--   재번역이 필요하면 해당 (news_id, locale) 행을 delete 후 재요청한다.
