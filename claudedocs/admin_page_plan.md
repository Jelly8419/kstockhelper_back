# KstockHelper 관리자 페이지 구현 계획

## 확정된 결정사항
- **활동 로그**: 신규 `activity_logs` 테이블 (type enum 구조, 삭제불가, 서버생성)
- **스키마 확장**: `users`에 `status` + `bybit_uid_status` 둘 다 추가, Bybit도 PRD 4종 상태(not_applied/pending/approved/rejected) 그대로
- **관리자 인증**: 자체 JWT (`admins` 테이블 + bcrypt + jsonwebtoken), 일반 유저(Supabase Auth)와 완전 분리
- **범위**: 전체 (Part 1 리스트 + Part 2 상세/등급/로그/메모)

## 등급/상태 용어 매핑 (DB ↔ PRD)
- DB `tier`: `free`/`premium` ↔ PRD `GENERAL`/`PREMIUM` → **API 경계에서 변환** (DB는 free 유지, 응답은 GENERAL/PREMIUM)
- 회원 상태: `status` = `active`/`inactive` (PRD 활성/비활성, 탈퇴=inactive soft delete)

---

## Phase 0. 의존성 설치
```
npm i jsonwebtoken bcryptjs
npm i -D @types/jsonwebtoken @types/bcryptjs
```

## Phase 1. DB 스키마 (Supabase에서 실행할 SQL — README에 문서화)
사용자가 직접 실행하거나 스크립트로 적용. 변경 내용:

```sql
-- 1) users: 회원 상태 + Bybit UID 상태 컬럼
alter table users add column if not exists status text not null default 'active';   -- active | inactive
alter table users add column if not exists bybit_uid_status text not null default 'not_applied'; -- not_applied|pending|approved|rejected

-- 2) admins: 관리자 계정 (수동 생성)
create table if not exists admins (
  id uuid primary key default gen_random_uuid(),
  admin_id text unique not null,          -- 로그인 아이디 (이메일 또는 식별자)
  password_hash text not null,            -- bcrypt
  created_at timestamptz default now()
);
grant select, insert, update on public.admins to service_role;

-- 3) activity_logs: 통합 활동 로그 (삭제 불가 운영)
create table if not exists activity_logs (
  id bigint generated always as identity primary key,
  user_id uuid not null references users(id),
  type text not null,                     -- UID_APPLIED|UID_APPROVED|UID_REJECTED|UID_CHANGE_REQUESTED|TIER_CHANGED|PREMIUM_AUTO_APPROVED|ADMIN_MANUAL_CHANGE
  exchange text,                          -- BINANCE | BYBIT (해당 시)
  uid text,                               -- UID (해당 시)
  from_tier text,                         -- 등급 변경 시
  to_tier text,                           -- 등급 변경 시
  created_at timestamptz default now()
);
create index if not exists activity_logs_user_id_idx on activity_logs (user_id, created_at desc);
grant select, insert on public.activity_logs to service_role;

-- 4) admin_memo: 회원 상세 메모 (users 컬럼으로 단순 처리, 최대 1000자)
alter table users add column if not exists admin_memo text;

-- 5) Binance 승인 시 activity_logs 자동 기록 트리거 (AFTER UPDATE)
--    binance_uid_status 가 'approved' 로 바뀌면 UID_APPROVED 로그를 남기고,
--    같은 변경에서 tier 가 premium 으로 올라갔다면 TIER_CHANGED 로그도 함께 남긴다.
--    (tier 승격 자체는 기존 BEFORE 트리거 fn_binance_approved_to_premium 가 처리)
create or replace function fn_binance_approved_log()
returns trigger as $$
begin
  if new.binance_uid_status = 'approved'
     and (old.binance_uid_status is distinct from new.binance_uid_status) then
    -- UID 승인 로그
    insert into activity_logs (user_id, type, exchange, uid, created_at)
    values (new.id, 'UID_APPROVED', 'BINANCE', new.binance_uid, now());

    -- 승인으로 tier 가 실제로 바뀐 경우만 등급 변경 로그 추가
    if old.tier is distinct from new.tier then
      insert into activity_logs (user_id, type, from_tier, to_tier, created_at)
      values (new.id, 'TIER_CHANGED', old.tier, new.tier, now());
    end if;
  end if;
  return null;  -- AFTER 트리거는 반환값 무시
end;
$$ language plpgsql;

drop trigger if exists trg_binance_approved_log on users;
create trigger trg_binance_approved_log
  after update on users
  for each row
  execute function fn_binance_approved_log();
```

> 메모는 회원별 1건이라 별도 테이블 대신 `users.admin_memo` 컬럼으로 처리(YAGNI). 수정 이력 미보관(MVP).
> CHECK 제약은 생략(서비스 레이어에서 검증) — 기존 테이블 스타일과 일관.
>
> **Binance 승인 로그 트리거 동작**:
> - 관리자가 Supabase 대시보드에서 `binance_uid_status`를 `approved`로 바꾸면 →
>   ① 기존 `BEFORE` 트리거가 `tier='premium'` 승격 → ② 신규 `AFTER` 트리거가 `UID_APPROVED`(BINANCE) + (등급 실제 변경 시) `TIER_CHANGED` 로그 자동 INSERT.
> - `tier` enum이 `from_tier`/`to_tier`(text)에 들어갈 때 PostgreSQL이 자동 캐스팅하므로 별도 변환 불필요.
> - 이로써 "Binance 승인 로그 누락" 이슈는 **DB 레벨에서 해결** → Phase 7의 한계 제거.

## Phase 2. 환경변수 (env.ts + .env.example)
```
JWT_SECRET=<랜덤 시크릿>          # 관리자 토큰 서명
ADMIN_TOKEN_TTL=8h               # (선택) 토큰 만료, 기본 8h
```

## Phase 3. 타입 정의 (src/types/index.ts 확장)
- `AdminTier = 'GENERAL' | 'PREMIUM'` (API 표면)
- `UserStatus = 'active' | 'inactive'`
- `UidStatus = 'not_applied'|'pending'|'approved'|'rejected'`
- `ActivityLogType`, `ActivityLog`, `AdminUserListItem`, `AdminUserDetail`
- 응답 DTO: `AdminLoginResponse`, `AdminUserListResponse`, `AdminUserDetailResponse`
- tier 변환 헬퍼 `toApiTier(dbTier)` / `toDbTier(apiTier)`

## Phase 4. 인증 인프라
- `src/config/env.ts`: jwtSecret, adminTokenTtl 추가
- `src/services/admin.service.ts`:
  - `verifyAdminCredentials(adminId, password)` → bcrypt 비교, admin row 반환
  - `issueAdminToken(admin)` → jwt.sign
- `src/middleware/adminAuth.ts`:
  - Authorization: Bearer 검증 → 만료/무효 시 401 (PRD: "세션이 만료되었습니다")
  - `req.admin` 주입
- `scripts/createAdmin.ts`: 관리자 계정 수동 생성 CLI (PRD: DB 수동 생성) — `npx tsx scripts/createAdmin.ts <adminId> <password>`

## Phase 5. 서비스 레이어 (admin.service.ts 통합)
- `listUsers()` → 회원 리스트 (이메일/tier/승인거래소/가입일/status)
  - 승인 거래소: `binance_uid_status==='approved'` → BINANCE, `bybit_uid_status==='approved'` → BYBIT 배열
- `getUserDetail(userId)` → 상세 + exchangeUids 배열 + activityLogs(최신순) + adminMemo
- `getActivityLogs(userId)` → activity_logs 조회
- `changeMembershipTier(userId, apiTier)` → tier 변경 + **activity_logs에 TIER_CHANGED 기록** (from/to). UID 상태 불변
- `saveMemo(userId, memo)` → 1000자 검증 후 저장
- `appendActivityLog(...)` → 공용 로그 기록 헬퍼

## Phase 6. 라우트
`src/routes/admin.routes.ts` (마운트: `/internal/admin`)
- `POST /auth/login` → 로그인, accessToken 발급 (미들웨어 없음)
- 이하 전부 `adminAuth` 미들웨어 적용:
  - `GET /users` → 리스트
  - `GET /users/:userId` → 상세
  - `PATCH /users/:userId/membership-tier` → 등급 변경
  - `PATCH /users/:userId/memo` → 메모 저장
- `app.ts`에 `app.use('/internal/admin', adminRouter)` 추가 + CORS methods에 PATCH 추가

## Phase 7. 기존 로직에 로그 연동 (이력 누적 시작점)
- `binance.routes.ts`의 connect 성공 시 → `UID_APPLIED`(exchange=BINANCE) 기록
- `bybit.routes.ts`의 verify 성공 시 → `UID_APPROVED`(exchange=BYBIT) + `PREMIUM_AUTO_APPROVED` 기록, `bybit_uid_status='approved'` 세팅
- **Binance approved 로그는 DB 트리거(`trg_binance_approved_log`)가 자동 기록** → 서버 경유 불필요, 누락 이슈 해결됨 (Phase 1 참조)

## Phase 8. 검증 & 문서
- `npm run build` (tsc) 통과 확인
- `npm run lint` 통과 확인
- 로컬 수기 테스트: createAdmin → login → users 리스트 → 상세 → tier 변경 → 메모
- README에 관리자 API 섹션 + 신규 스키마 SQL 추가

---

## 영향받는/신규 파일
**신규**
- `scripts/createAdmin.ts`
- `src/middleware/adminAuth.ts`
- `src/services/admin.service.ts`
- `src/routes/admin.routes.ts`

**수정**
- `package.json` (deps)
- `src/config/env.ts` (jwtSecret 등)
- `src/types/index.ts` (관리자 타입)
- `src/app.ts` (라우터 마운트, PATCH CORS)
- `src/routes/binance.routes.ts` / `bybit.routes.ts` (로그 연동)
- `src/services/users.service.ts` (bybit_uid_status 세팅 추가 가능)
- `.env.example`, `README.md`

## 미해결/주의
- ~~Binance approved 로그 누락~~ → **해결**: DB 트리거 `trg_binance_approved_log`가 `UID_APPROVED`(BINANCE) + `TIER_CHANGED` 자동 INSERT (Phase 1).
- **과거 이력 없음**: activity_logs는 지금부터 누적. 기존 회원의 과거 신청/승인 이력은 비어있음 (PRD에도 소급 요구 없음).
- **tier enum**: DB `tier`가 enum이면 'free'/'premium'만 존재 — 추가 값 불필요(매핑은 API 레이어).
