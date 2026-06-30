-- 0015_real_estate_admin.sql
-- 부동산 구매 요청 어드미 관리(PRD: Admin - 부동산 구매 요청 관리) 대응 스키마 변경.
--
-- 0014에서 real_estate_requests를 생성·운영 적용했으나, 어드미 PRD 확정본과 두 가지가 어긋난다:
--  ① status 값 집합: 0014는 NEW/IN_PROGRESS/DONE/SPAM(4종)이었으나 PRD 6절은 "상태 2개만"
--     — 접수(RECEIVED) / 답변완료(ANSWERED). DB는 영문, UI 라벨(접수/답변완료)은 프론트가 매핑.
--  ② 관리자 메모(PRD 8.2): 단일 필드 덮어쓰기 textarea → admin_memo 컬럼 신설.
--
-- 전제: 0014 적용 후 실데이터 제출 0건(확인됨) → 기존 row 값 변환 불필요. 단순 CHECK 교체.
--       그래도 안전하게 "혹시 남아있을 NEW류"를 RECEIVED로 정규화한 뒤 새 제약을 건다(멱등).
--
-- 권한: 조회/상태변경/메모저장은 모두 0014의 grant(select, insert, update to service_role)로
--       커버된다. 추가 grant 불필요.
--
-- 실행: Supabase SQL Editor에서 전체 실행. 멱등(재실행 안전).

-- 1) status 제약 교체 — 4종 → 2종(RECEIVED/ANSWERED).
--    순서: 기존 CHECK 제거 → 잔존 값 정규화 → default 변경 → 새 CHECK 추가.
alter table public.real_estate_requests
  drop constraint if exists real_estate_requests_status_check;

-- 0014에서 인라인 check로 만든 제약은 이름이 자동부여(보통 <table>_status_check)지만,
-- 명시 이름이 다를 수 있어 방어적으로 한 번 더 시도(존재하지 않으면 무시).
do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.real_estate_requests'::regclass
      and conname = 'rer_status_valid'
  ) then
    alter table public.real_estate_requests drop constraint rer_status_valid;
  end if;
end $$;

-- 잔존 값 정규화(제출 0건이라 통상 영향 없음). NEW→RECEIVED, 그 외 비표준값→RECEIVED.
update public.real_estate_requests
   set status = 'RECEIVED'
 where status not in ('RECEIVED', 'ANSWERED');

-- default를 RECEIVED로(폼 신규 제출 기본 상태 = 접수). 폼 insert는 status 미지정 → default 적용.
alter table public.real_estate_requests
  alter column status set default 'RECEIVED';

alter table public.real_estate_requests
  add constraint rer_status_valid check (status in ('RECEIVED', 'ANSWERED'));

-- 2) 관리자 메모(PRD 8.2) — 단일 필드, nullable. 덮어쓰기 저장(히스토리 아님).
alter table public.real_estate_requests
  add column if not exists admin_memo text;

-- 주의
-- - status 라벨 매핑: RECEIVED='접수', ANSWERED='답변완료' (프론트 i18n/라벨 담당).
-- - admin_memo는 service_role(어드미 API)만 수정. 0014의 update grant로 커버됨.
