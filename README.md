# K-Stock Helper Backend

Node.js + Express + TypeScript + Supabase 기반 백엔드.
DART 공시 수집(1분), 시장 데이터 수집(공공 API, 1일 1회), 네이버 뉴스 + Claude 번역/판별 파이프라인(10분)을 수행한다.

## 스택

- Node.js + Express + TypeScript
- Supabase (`service_role` 키, 서버 전용)
- node-cron (인메모리 스케줄러)
- DART OpenAPI (공시) + document.xml (공시 원문)
- 금융위원회 공공데이터 API (주식/지수 시세) + 한국은행 ECOS (환율)
- 네이버 검색 API (뉴스)
- Anthropic Claude (분류: haiku-4-5 / 번역·요약: sonnet-4-6)

## 폴더 구조

```
src/
├── config/        env 검증, Supabase / Anthropic 클라이언트
├── constants/     종목·지수·환율 메타, 게시 대상 공시 유형
├── collectors/    DART / 시장데이터(publicStock·publicIndex·bokFx) / Naver
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
| `PUBLIC_DATA_API_KEY` | 공공데이터포털 인증키 (금융위 주식/지수 시세) |
| `BOK_API_KEY` | 한국은행 ECOS 인증키 (환율) |
| `BYBIT_AFFILIATE_API_KEY` | Bybit Affiliate API 키 (affiliate 권한) |
| `BYBIT_AFFILIATE_API_SECRET` | Bybit Affiliate API 시크릿 |
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

### 시장 데이터 (공공 API, 장 마감 후 1일 1회 — 16:00 KST)
- **종목** (금융위원회 주식시세정보): 005930 / 000660 / 005380
- **지수** (금융위원회 지수시세정보): 코스피 / 코스닥
- **환율** (한국은행 ECOS): USD/KRW (731Y001)
- 모두 **일별 종가 기준**(장중 실시간 아님) → 1일 1회 갱신으로 충분
- `symbol` 키는 기존 형식 유지 (005930.KS / ^KS11 / KRW=X) — 프론트 호환
- 3개 소스 병렬 호출, 한 소스 실패가 전체를 막지 않음(`Promise.allSettled`)
- 환율은 등락(change/change_percent)을 제공하지 않아 `null`
- 콜드스타트 1회 즉시 수집, `symbol` 기준 upsert(심볼당 1행)

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
- Bybit `aff-user-list`에 해당 UID가 있으면(=우리 레퍼럴) → `users.tier='premium'`, `bybit_uid` 연결
- 이미 다른 계정에 연동된 UID는 409, userId 없음은 404, 미가입은 success=false
- CORS: `FRONTEND_URL` origin만 허용

### `POST /api/binance/connect`
유저가 Binance UID를 입력해 연동을 **신청**(수동 승인 방식).
```
요청: { "binanceUid": "12345678", "userId": "<users.id>" }
응답: { "success": boolean, "message": string }
```
- Bybit와 달리 **외부 API 자동 검증 없음** — `binance_uid` 저장 + `binance_uid_status='pending'`만 설정
- 이미 다른 계정에 연동된 UID는 409, userId 없음은 404
- **승인은 관리자가 Supabase 대시보드에서 수동** 처리 (`binance_uid_status`를 `approved`/`rejected`로 변경)
- `approved`로 바뀌면 **DB 트리거가 자동으로 `tier='premium'`** 설정 (아래 스키마 참조)
- 상태머신: `not_applied → pending → approved | rejected`

### `GET /health`
liveness 체크 — `{ status: 'ok', time }`

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
