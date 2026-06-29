-- 0014_real_estate_requests.sql
-- 부동산 구매 지원 요청 폼(리드 수집) — 신규 테이블.
-- (PRD: 부동산 구매 지원 서비스 / 백엔드회신·프론트회신_부동산_구매지원요청폼.md)
--
-- 외국인 대상 한국 부동산 구매 지원 서비스의 "구매 지원 요청 폼" 제출 데이터를 적재한다.
-- 비회원도 로그인 없이 제출하며, 적재는 백엔드 엔드포인트(POST /api/real-estate/requests)가
-- service_role로 수행한다. 클라(브라우저/anon)는 이 테이블에 직접 접근하지 않는다.
--
-- 호출 경로: 브라우저 → 프론트 BFF(얇은 프록시, service_role 없음) → 백엔드 → service_role insert.
--
-- 설계 결정(회신서 기준):
--  - 적재 주체: 프론트가 아니라 백엔드 엔드포인트. service_role 키를 프론트로 확산하지 않고,
--    이미 service_role을 안전 보관하는 백엔드(Railway)가 받는다.
--  - 권한 모델: 0001_premium_applications / 0008_news_translations와 동일한 "닫힌 테이블" 패턴.
--    RLS off + service_role 전용 grant + anon/authenticated 무권한. (이 레포 표준)
--    RLS를 켜는 대신 grant 자체를 service_role에만 부여하므로 정책 평가가 필요 없다(단순·명확).
--
-- 실행: Supabase SQL Editor에서 전체 실행. 멱등(재실행 안전).

-- 1) 리드 수집 테이블.
create table if not exists public.real_estate_requests (
  id                    uuid primary key default gen_random_uuid(),
  email                 text not null,
  country_of_residence  text not null,
  budget_currency       text not null,
  budget_min            numeric(18, 2) not null,
  budget_max            numeric(18, 2) not null,
  property_type         text not null,   -- apartment | officetel | other | not_sure
  currently_in_korea    boolean not null,
  message               text not null,
  -- 처리상태(어드민 추후 대비). applications.status 패턴과 동일.
  status                text not null default 'NEW'
                        check (status in ('NEW', 'IN_PROGRESS', 'DONE', 'SPAM')),
  user_id               uuid references public.users (id) on delete set null,  -- NULL = guest
  locale                text,
  country_code          text,  -- BFF 전달 countryCode 우선, 없으면 백엔드 geoip 폴백
  created_at            timestamptz not null default now(),

  constraint rer_budget_min_le_max check (budget_min <= budget_max),
  constraint rer_budget_nonneg check (budget_min >= 0),
  constraint rer_message_len check (char_length(message) <= 500),
  constraint rer_property_type_valid check (
    property_type in ('apartment', 'officetel', 'other', 'not_sure')
  ),
  -- 통화 9종 고정. 신규 통화 추가 시 이 제약을 함께 갱신할 것.
  constraint rer_currency_valid check (
    budget_currency in ('USD', 'CNY', 'CAD', 'TWD', 'AUD', 'JPY', 'VND', 'NZD', 'KRW')
  )
);

-- 어드민 목록(최신순) / 이메일 조회용 인덱스.
create index if not exists rer_created_at_idx on public.real_estate_requests (created_at desc);
create index if not exists rer_email_idx      on public.real_estate_requests (email);
-- 어드민 미처리 큐(status + 최신순)용 인덱스.
create index if not exists rer_status_created_idx
  on public.real_estate_requests (status, created_at desc);

-- 2) 권한 — service_role 전용. (0001 applications와 동일 원칙)
--    [중요] 신규 테이블은 service_role에 권한을 자동 상속하지 않으므로 명시적 grant 필요.
--    delete는 부여하지 않는다(리드 이력 보존). 삭제가 필요하면 status='SPAM'으로 소프트 처리.
grant select, insert, update on public.real_estate_requests to service_role;
-- anon/authenticated에는 어떤 권한도 주지 않는다(클라 직접 접근 전면 차단).

-- 3) RLS off — 권한을 service_role에만 부여했으므로 RLS 없이도 외부(anon 키) 접근 불가.
--    (RLS enable + 정책 미생성으로도 같은 효과지만, 이 레포는 disable+grant로 통일한다.)
alter table public.real_estate_requests disable row level security;

-- 주의
-- - 적재 경로: POST /api/real-estate/requests (백엔드) → service_role insert. 프론트 BFF만 호출.
-- - 어드민 조회는 추후 /internal/admin 라우터에 service_role 기반으로 추가한다(본 작업 범위 외).
