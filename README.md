# K-Stock Helper Backend

Node.js + Express + TypeScript + Supabase 기반 백엔드.
DART 공시 수집(1분), 시장 데이터 수집(공공 API, 1일 1회), 네이버 뉴스 + Claude 번역/판별 파이프라인(10분)을 수행한다.

## 스택

- Node.js + Express + TypeScript
- Supabase (`service_role` 키, 서버 전용)
- node-cron (인메모리 스케줄러)
- DART OpenAPI (공시) + document.xml (공시 원문)
- 한국투자증권 KIS OpenAPI (주식/지수 현재가) + ExchangeRate-API (환율)
- 네이버 검색 API (뉴스)
- Anthropic Claude (분류: haiku-4-5 / 번역·요약: sonnet-4-6)

## 폴더 구조

```
src/
├── config/        env 검증, Supabase / Anthropic 클라이언트
├── constants/     종목·지수·환율 메타, 게시 대상 공시 유형
├── collectors/    DART / 시장데이터(kisStock·kisIndex·exchangeRate) / Naver
├── pipeline/      Claude 분류·브리프·DART번역 + 중복제거(dedup)
├── services/      Supabase 저장 (news / market_data / processing_logs)
├── scheduler/     node-cron 잡 등록
├── utils/         logger, URL/제목 정규화, 유사도
├── types/         DART/시장/Naver/파이프라인/DB 타입
├── app.ts         Express 앱 (health check)
└── index.ts       엔트리 (서버 + 스케줄러)
```

## 설치 & 실행

```bash
npm install
cp .env.example .env   # 값 채우기
npm run dev            # 개발 (tsx watch)
npm run build && npm start   # 프로덕션
npm run lint
```

## 환경변수 (`.env`)

| 변수 | 설명 |
|---|---|
| `SUPABASE_URL` | Supabase 프로젝트 URL |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role 키 (서버 전용, 노출 금지) |
| `DART_API_KEY` | DART OpenAPI 인증키 |
| `NAVER_CLIENT_ID` | 네이버 검색 API client id |
| `NAVER_CLIENT_SECRET` | 네이버 검색 API client secret |
| `ANTHROPIC_API_KEY` | Anthropic Claude API 키 |
| `KIS_APP_KEY` | 한국투자증권 KIS OpenAPI 앱키 (주식/지수 현재가, 실전계좌) |
| `KIS_APP_SECRET` | 한국투자증권 KIS OpenAPI 앱시크릿 |
| `BYBIT_AFFILIATE_API_KEY` | Bybit Affiliate API 키 (affiliate 권한) |
| `BYBIT_AFFILIATE_API_SECRET` | Bybit Affiliate API 시크릿 |
| `JWT_SECRET` | 관리자 페이지 JWT 서명 시크릿 (필수, 랜덤 문자열) |
| `ADMIN_TOKEN_TTL` | 관리자 토큰 만료 (선택, 기본 8h) |
| `FRONTEND_URL` | CORS 허용 origin (기본 https://kstockhelper.com) |
| `MAX_CLASSIFY_PER_RUN` | 한 주기당 Claude 분류 호출 상한 (기본 10) |
| `PORT` | 서버 포트 (기본 8080) |

## 수집 동작

### DART 공시 (1분 간격)
- 대상: 삼성전자(005930) / SK하이닉스(000660) / 현대차(005380)
- 각 종목의 당일 공시 목록 조회 → `news` 테이블에 저장 (`status=collected`)
- **중복 방지**: `unique(source, external_id)`, `external_id` = 접수번호(`rcept_no`)
- **신규 공시 중 게시 대상 21개 유형**만 번역 파이프라인 진행:
  1. `document.xml`(ZIP)로 공시 원문 텍스트 확보 (실패 시 제목/메타만)
  2. Claude(sonnet-4-6) 번역/요약 → `translated_title, english_translation, summary, key_figures, key_points` 채움, `status=published`
  3. 대상 외 유형은 `disclosure_type_unconfirmed` 로그 후 수집만 유지
- 게시 대상 유형은 `src/constants/disclosureTypes.ts` 참조

### 시장 데이터 (주가/지수/환율 — 평일 장중 5분 간격)
- **종목** (KIS 현재가): 005930 / 000660 / 005380
- **지수** (KIS 업종 현재지수): 코스피(0001) / 코스닥(1001)
- **환율** (ExchangeRate-API, 키 불필요): USD/KRW (값만, 등락 미노출 → `null`)
- cron은 매 5분 실행하되, 평일 **09:01~15:41 KST** 창 안에서만 실제 수집
- 창 밖(장 종료 후·주말·공휴일)에는 스킵 → DB 마지막 값 고정
- 공휴일은 한투가 빈 응답 → 자연히 버림 처리 (별도 달력 불필요)
- KIS는 OAuth 토큰(24h)을 메모리+파일 캐싱해 재사용 (`src/config/kisAuth.ts`)
- 한투 유량제한(EGW00201)은 호출 간격 + 재시도(`withRetry`)로 흡수
- `symbol` 키는 기존 형식 유지 (005930.KS / ^KS11 / KRW=X) — 프론트 호환
- 콜드스타트 1회 즉시 수집(MARKET은 시간창 무시), `symbol` 기준 upsert(심볼당 1행)

### 네이버 뉴스 + Claude 파이프라인 (20분 간격)
- 검색 키워드: 삼성전자 / SK하이닉스 / 현대차 (종목당 15건)
- `source='NAVER'`, `external_id` = 정규화된 링크(canonical_url)
- **URL 정규화**: utm_*, fbclid, gclid 등 추적 파라미터 제거 + 쿼리 정렬
- **제목 정규화**: `[속보][단독][특징주][종합](종합)(2보)(상보)` 등 + HTML 태그/엔티티 제거
- **중복 제거**(최근 12시간 + 종목 겹침 후보 비교): canonical_url 동일 / 제목 유사도 ≥85% / snippet 유사도 ≥80% → skip
- **Claude classification**(haiku-4-5, 주기당 최대 `MAX_CLASSIFY_PER_RUN`건):
  게시 = `decision=publish AND confidence≥80 AND related_stocks≥1`
- **Claude brief**(sonnet-4-6): `translated_title, summary(≤300자), key_points(≤3개)` 생성 → `status=published`

### Bybit 레퍼럴 동기화 (매일 02:00 KST)
- Bybit Affiliate API(`/v5/affiliate/aff-user-list`)로 전체 레퍼럴 유저 조회
- 이미 `bybit_uid`가 연결된 유저가 레퍼럴 목록에 있는지 재확인 → premium 유지/재승격
- 레퍼럴 목록에서 빠진 연동 유저는 경고 로그만(강등 정책 미정)
- **신규 자동 승격 없음**: verify 엔드포인트가 최초 연결 트리거(아래 API 참조)

### 처리 로그
모든 단계 결과를 `processing_logs` 테이블 + 콘솔에 기록:
`duplicate / skipped / filtered / classification_publish / classification_skip / gpt_classification_failed / gpt_brief_failed / published / disclosure_type_unconfirmed`

## API 엔드포인트

### `POST /api/bybit/verify`
프론트엔드(kstockhelper.com)에서 유저가 Bybit UID를 입력해 레퍼럴 가입을 인증.
```
요청: { "bybitUid": "12345678", "userId": "<users.id>" }
응답: { "success": boolean, "message": string }
```
- Bybit `aff-user-list`에 해당 UID가 있으면(=우리 레퍼럴) → `users.tier='premium'`, `bybit_uid` 연결, `bybit_uid_status='approved'`
- 활동 로그(`activity_logs`)에 `UID_APPROVED`(BYBIT) + `PREMIUM_AUTO_APPROVED` 기록
- 이미 다른 계정에 연동된 UID는 409, userId 없음은 404, 미가입은 success=false
- CORS: `FRONTEND_URL` origin만 허용

### `POST /api/binance/connect`
유저가 Binance UID를 입력해 연동을 **신청**(수동 승인 방식).
```
요청: { "binanceUid": "12345678", "userId": "<users.id>" }
응답: { "success": boolean, "message": string }
```
- Bybit와 달리 **외부 API 자동 검증 없음** — `binance_uid` 저장 + `binance_uid_status='pending'`만 설정
- 활동 로그(`activity_logs`)에 `UID_APPLIED`(BINANCE) 기록
- 이미 다른 계정에 연동된 UID는 409, userId 없음은 404
- **승인은 관리자가 Supabase 대시보드에서 수동** 처리 (`binance_uid_status`를 `approved`/`rejected`로 변경)
- `approved`로 바뀌면 **DB 트리거가 자동으로 `tier='premium'`** 설정 + `activity_logs`에 `UID_APPROVED`/`TIER_CHANGED` 자동 기록 (아래 스키마 참조)
- 상태머신: `not_applied → pending → approved | rejected`

### `GET /health`
liveness 체크 — `{ status: 'ok', time }`

## 관리자 페이지 API (`/internal/admin`)

일반 유저 인증과 **분리된 자체 JWT**(`JWT_SECRET` 서명). 관리자 계정은 DB에서 수동 생성한다.

### 관리자 계정 생성 (CLI)
```bash
npx tsx scripts/createAdmin.ts <adminId> <password>   # 비번 최소 8자, 기존 adminId면 비번 갱신
```

### `POST /internal/admin/auth/login`
```
요청: { "adminId": "admin", "password": "..." }
응답: { "accessToken": "<JWT>" }   # 실패 시 401 { success:false, message }
```
- 토큰 만료: `ADMIN_TOKEN_TTL`(기본 8h). 이하 모든 엔드포인트는 `Authorization: Bearer <token>` 필요 (무효/만료 시 401)

### `GET /internal/admin/users`
회원 리스트(가입일 최신순, 탈퇴 회원 포함).
```
응답: { "users": [{ userId, email, membershipTier, approvedExchanges, createdAt, status }] }
```
- `membershipTier`: `GENERAL | PREMIUM` (DB `tier` free/premium 매핑)
- `approvedExchanges`: **approved 상태인 거래소만** 배열로 (예: `["BINANCE","BYBIT"]`). pending/rejected 제외
- `status`: `active | inactive`(탈퇴)

### `GET /internal/admin/users/:userId`
회원 상세. 미존재 시 404.
```
응답: { userId, email, createdAt, membershipTier, status,
        exchangeUids: [{ exchange, uid, status }],   // BINANCE/BYBIT 각각, status=not_applied|pending|approved|rejected
        activityLogs: [{ type, exchange, uid, fromTier, toTier, createdAt }],  // 최신순
        adminMemo }
```

### `PATCH /internal/admin/users/:userId/membership-tier`
```
요청: { "membershipTier": "GENERAL" | "PREMIUM" }
```
- 등급만 변경, **UID 상태는 건드리지 않음**. 실제 변경 시 `activity_logs`에 `TIER_CHANGED` 기록
- 동일 등급이면 변경 없이 200(`이미 동일한 등급입니다.`) — 멱등. 잘못된 값은 400, 미존재 404

### `PATCH /internal/admin/users/:userId/memo`
```
요청: { "memo": "..." }   # 최대 1,000자(초과 시 400). 회원별 1건, 수정 이력 미보관
```

> 활동 로그는 `select, insert` 권한만 부여(삭제 권한 없음) → "로그 삭제 불가"(PRD) DB 레벨 보장.

## DB 스키마

### `news` (기존 테이블 + 파이프라인용 컬럼 확장)
기존 컬럼(실DB 기준): `id, source, external_id, title, published_at, created_at, body, summary, key_points, category, preview` + `unique(source, external_id)`

아래 ALTER TABLE을 **Supabase에서 실행**해 누락 컬럼 + 파이프라인 컬럼을 추가한다:
```sql
alter table news
  -- 수집 기본 컬럼 (실DB에 누락되어 있던 것)
  add column if not exists stock_code          text,
  add column if not exists url                 text,
  add column if not exists is_premium          boolean default false,
  -- 파이프라인 결과 컬럼
  add column if not exists translated_title    text,
  add column if not exists english_translation text,
  add column if not exists key_figures         jsonb,
  add column if not exists related_stocks      jsonb,
  add column if not exists confidence          int,
  add column if not exists canonical_url       text,
  add column if not exists status              text default 'collected';

-- service_role 권한 (Supabase에서 누락된 경우)
grant select, insert, update, delete on public.news to service_role;
grant select, insert, update, delete on public.market_data to service_role;
grant select, insert, update, delete on public.processing_logs to service_role;
grant usage, select on all sequences in schema public to service_role;
```
> 활용: 뉴스 브리프 → `translated_title/summary/key_points/category/related_stocks/confidence`,
> DART 번역 → `translated_title/english_translation/summary/key_figures/key_points`,
> 원문 snippet/본문 → `body`, 정규화 URL → `canonical_url`

### `market_data` (신규 — 아래 SQL을 Supabase에서 실행)
```sql
create table if not exists market_data (
  symbol text primary key,
  name text,
  type text,                 -- stock | index | fx
  price numeric,
  change numeric,
  change_percent numeric,
  updated_at timestamptz default now()
);
```

### `processing_logs` (신규 — 아래 SQL을 Supabase에서 실행)
```sql
create table if not exists processing_logs (
  id bigint generated always as identity primary key,
  source text,              -- NAVER | DART
  external_id text,
  stage text,               -- dedup | classification | brief | dart_translate
  status text not null,
  reason text,
  meta jsonb,
  created_at timestamptz default now()
);
```

### `users` (기존 테이블 — Bybit 연동 컬럼 추가)
`tier`는 이미 존재. `bybit_uid` 컬럼을 추가하고 service_role 권한을 부여한다:
```sql
alter table users add column if not exists bybit_uid text;
create unique index if not exists users_bybit_uid_key on users (bybit_uid);

grant select, update on public.users to service_role;
```
> `tier`가 enum 타입이면 `'premium'` 값이 enum에 포함돼 있어야 한다.
> 없으면: `alter type <tier_enum> add value 'premium';`
> verify/스케줄러는 `tier='premium'` + `bybit_uid` 만 갱신한다.

### `users` — Binance 연동 컬럼 + 자동 승격 트리거
```sql
-- binance_uid 는 이미 추가됨. 상태 컬럼 추가:
alter table users add column if not exists binance_uid_status text default 'not_applied';
-- (binance_uid unique 미설정 시) create unique index if not exists users_binance_uid_key on users (binance_uid);

-- binance_uid_status = 'approved' 로 바뀌면 tier 를 자동으로 premium 승격
create or replace function fn_binance_approved_to_premium()
returns trigger as $$
begin
  if new.binance_uid_status = 'approved'
     and (old.binance_uid_status is distinct from new.binance_uid_status) then
    new.tier := 'premium';
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_binance_approved on users;
create trigger trg_binance_approved
  before update on users
  for each row
  execute function fn_binance_approved_to_premium();
```
> 동작: 관리자가 대시보드에서 `binance_uid_status`를 `approved`로 바꾸면 같은 UPDATE에서 `tier='premium'`이 자동 설정된다.
> `rejected`/`pending`은 tier를 건드리지 않는다 (강등은 정책 미정 — 필요 시 별도 처리).
> 상태값: `not_applied | pending | approved | rejected`

### 관리자 페이지 (신규 — 아래 SQL을 Supabase에서 실행)
```sql
-- 1) users: 회원 상태 + Bybit UID 상태 + 관리자 메모 컬럼
alter table users add column if not exists status text not null default 'active';            -- active | inactive
alter table users add column if not exists bybit_uid_status text not null default 'not_applied'; -- not_applied|pending|approved|rejected
alter table users add column if not exists admin_memo text;                                   -- 최대 1000자(서비스 레이어 검증)

-- 2) admins: 관리자 계정 (수동 생성, bcrypt 비번)
create table if not exists admins (
  id uuid primary key default gen_random_uuid(),
  admin_id text unique not null,
  password_hash text not null,
  created_at timestamptz default now()
);
grant select, insert, update on public.admins to service_role;   -- delete 미부여(의도)
alter table public.admins disable row level security;

-- 3) activity_logs: 통합 활동 로그 (삭제 불가 운영)
create table if not exists activity_logs (
  id bigint generated always as identity primary key,
  user_id uuid not null references users(id),
  type text not null,        -- UID_APPLIED|UID_APPROVED|UID_REJECTED|UID_CHANGE_REQUESTED|TIER_CHANGED|PREMIUM_AUTO_APPROVED|ADMIN_MANUAL_CHANGE
  exchange text,             -- BINANCE | BYBIT (해당 시)
  uid text,
  from_tier text,            -- 등급 변경 시
  to_tier text,
  created_at timestamptz default now()
);
create index if not exists activity_logs_user_id_idx on activity_logs (user_id, created_at desc);
grant select, insert on public.activity_logs to service_role;     -- delete 미부여 → "로그 삭제 불가" DB 보장
grant usage, select on all sequences in schema public to service_role;
alter table public.activity_logs disable row level security;

-- 4) Binance 승인 시 activity_logs 자동 기록 트리거 (AFTER UPDATE)
--    대시보드에서 binance_uid_status='approved'로 바뀌면 서버를 안 거쳐도 로그가 남는다.
create or replace function fn_binance_approved_log()
returns trigger as $$
begin
  if new.binance_uid_status = 'approved'
     and (old.binance_uid_status is distinct from new.binance_uid_status) then
    insert into activity_logs (user_id, type, exchange, uid, created_at)
    values (new.id, 'UID_APPROVED', 'BINANCE', new.binance_uid, now());
    if old.tier is distinct from new.tier then
      insert into activity_logs (user_id, type, from_tier, to_tier, created_at)
      values (new.id, 'TIER_CHANGED', old.tier, new.tier, now());
    end if;
  end if;
  return null;
end;
$$ language plpgsql;

drop trigger if exists trg_binance_approved_log on users;
create trigger trg_binance_approved_log
  after update on users
  for each row
  execute function fn_binance_approved_log();
```
> 등급 매핑: DB `tier`(free/premium) ↔ API `membershipTier`(GENERAL/PREMIUM)는 서비스 레이어에서 변환.
> 활동 로그는 지금부터 누적 — 기존 회원의 과거 신청/승인 이력은 비어 있다(소급 없음).

## DART corp_code 매핑

DART는 종목코드가 아닌 8자리 고유번호(corp_code)를 사용한다. (DART API로 검증된 값)

| 종목 | code | corp_code |
|---|---|---|
| 삼성전자 | 005930 | 00126380 |
| SK하이닉스 | 000660 | 00164779 |
| 현대차 | 005380 | 00164742 |

종목 추가 시 `src/constants/stocks.ts`에 corp_code를 추가한다. (DART corpCode.xml 또는 list.json으로 확인)

## TODO (나중에)

- [x] Claude API 번역/요약 파이프라인 (DART 공시 번역, 뉴스 브리프)
- [x] 뉴스 API 연동 (네이버 검색 API + Claude 분류/브리프)
- [x] Bybit 레퍼럴 연동 (verify 엔드포인트 + 1일 1회 동기화)
- [x] Binance UID 연동 (connect 엔드포인트 + 수동 승인 + DB 트리거)
- [x] 관리자 페이지 API (로그인/회원리스트/상세/등급변경/메모 + 통합 활동 로그)
