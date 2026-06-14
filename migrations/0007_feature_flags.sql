-- 0007_feature_flags.sql
-- Feature Flags — 기능 노출 on/off 토글 (관리자 제어, 프론트 공개 읽기).
--
-- 용도:
--   - 관리자가 특정 기능(예: Price Gap Monitor)의 프론트 노출을 켜고 끈다.
--   - 프론트는 공개 API(GET /api/feature-flags)로 현재 flag 상태를 읽어 UI 노출 분기.
--   - 관리자 UI는 /internal/admin/feature-flags(GET/PATCH)로 조회/변경.
--
-- 설계:
--   - key-value 구조라 향후 다른 기능에도 재사용 가능. MVP는 priceGapPublic 하나.
--   - 키가 없으면 프론트는 false(미노출)로 간주 → 안전한 기본값.
--
-- 노출 정책:
--   - 백엔드 API가 service_role로 읽고 가공해 응답. anon 직접 접근 불필요(권한 안 줌).
--
-- 실행: Supabase SQL Editor에서 전체 실행. 멱등(재실행 안전).

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) feature_flags
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.feature_flags (
  key        text primary key,                  -- 'priceGapPublic'
  enabled    boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by text                               -- 변경한 관리자 admin_id (감사용, nullable)
);

-- updated_at 자동 갱신 트리거
create or replace function public.fn_feature_flags_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists trg_feature_flags_touch on public.feature_flags;
create trigger trg_feature_flags_touch
  before update on public.feature_flags
  for each row execute function public.fn_feature_flags_touch_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) 초기 flag — priceGapPublic (기본 false = 미노출)
-- ─────────────────────────────────────────────────────────────────────────────
-- 이미 있으면 건드리지 않는다(운영 중 변경값 보존).
insert into public.feature_flags (key, enabled)
values ('priceGapPublic', false)
on conflict (key) do nothing;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3) 권한 — 백엔드(service_role) 전용
-- ─────────────────────────────────────────────────────────────────────────────
-- 프론트는 백엔드 API 경유로만 읽으므로 anon/authenticated 권한을 주지 않는다.
grant select, insert, update on public.feature_flags to service_role;
