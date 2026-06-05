# K-Stock Helper Backend

Node.js + Express + TypeScript + Supabase 기반 백엔드.
DART 공시 수집(1분), Yahoo Finance 주가/지수 수집(5분), 네이버 뉴스 + Claude 번역/판별 파이프라인(5분)을 수행한다.

## 스택

- Node.js + Express + TypeScript
- Supabase (`service_role` 키, 서버 전용)
- node-cron (인메모리 스케줄러)
- DART OpenAPI (공시) + document.xml (공시 원문)
- yahoo-finance2 (주가/지수/환율)
- 네이버 검색 API (뉴스)
- Anthropic Claude (분류: haiku-4-5 / 번역·요약: sonnet-4-6)

## 폴더 구조

```
src/
├── config/        env 검증, Supabase / Anthropic 클라이언트
├── constants/     종목 메타, 게시 대상 공시 유형
├── collectors/    DART / Yahoo / Naver 수집 + DART 원문(document.xml)
├── pipeline/      Claude 분류·브리프·DART번역 + 중복제거(dedup)
├── services/      Supabase 저장 (news / market_data / processing_logs)
├── scheduler/     node-cron 잡 등록
├── utils/         logger, 장시간, URL/제목 정규화, 유사도
├── types/         DART/Yahoo/Naver/파이프라인/DB 타입
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
| `MAX_CLASSIFY_PER_RUN` | 한 주기당 Claude 분류 호출 상한 (기본 20) |
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

### 주가/지수 (5분 간격)
- 종목: 005930.KS / 000660.KS / 005380.KS
- 지수/환율: KOSPI(^KS11) / KOSDAQ(^KQ11) / USD/KRW(KRW=X)
- 장 운영시간(**평일 09:00~15:35 KST**)에만 갱신, 그 외엔 마지막 값 고정
- 콜드스타트 1회는 강제 수집(force), `symbol` 기준 upsert

### 네이버 뉴스 + Claude 파이프라인 (5분 간격)
- 검색 키워드: 삼성전자 / SK하이닉스 / 현대차
- `source='NAVER'`, `external_id` = 정규화된 링크(canonical_url)
- **URL 정규화**: utm_*, fbclid, gclid 등 추적 파라미터 제거 + 쿼리 정렬
- **제목 정규화**: `[속보][단독][특징주][종합](종합)(2보)(상보)` 등 + HTML 태그/엔티티 제거
- **중복 제거**(최근 12시간 + 종목 겹침 후보 비교): canonical_url 동일 / 제목 유사도 ≥85% / snippet 유사도 ≥80% → skip
- **Claude classification**(haiku-4-5, 주기당 최대 `MAX_CLASSIFY_PER_RUN`건):
  게시 = `decision=publish AND confidence≥70 AND related_stocks≥1`
- **Claude brief**(sonnet-4-6): `translated_title, summary(≤300자), key_points(≤3개)` 생성 → `status=published`

### 처리 로그
모든 단계 결과를 `processing_logs` 테이블 + 콘솔에 기록:
`duplicate / skipped / filtered / classification_publish / classification_skip / gpt_classification_failed / gpt_brief_failed / published / disclosure_type_unconfirmed`

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
- [ ] Bybit/Binance 레퍼럴 연동
