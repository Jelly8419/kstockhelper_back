// ===== DART OpenAPI =====

/** DART list.json 응답의 개별 공시 항목 */
export interface DartDisclosure {
  corp_code: string;
  corp_name: string;
  stock_code: string;
  /** 보고서명 */
  report_nm: string;
  /** 접수번호 (공시 고유값) */
  rcept_no: string;
  /** 공시 제출인명 */
  flr_nm: string;
  /** 접수일자 YYYYMMDD */
  rcept_dt: string;
  rm: string;
}

/** DART list.json 전체 응답 */
export interface DartListResponse {
  status: string;
  message: string;
  page_no?: number;
  page_count?: number;
  total_count?: number;
  total_page?: number;
  list?: DartDisclosure[];
}

// ===== Supabase: news 테이블 =====
// 기존 스키마 + 파이프라인용 확장 컬럼:
//   기존: id, source, external_id, stock_code, title, url, published_at,
//         created_at, body, summary, key_points, category, is_premium, preview
//   확장: translated_title, english_translation, key_figures(jsonb),
//         related_stocks(jsonb), confidence(int), canonical_url, status
//   unique(source, external_id)

/** news.category enum (DB: news_category) */
export type NewsCategory = 'disclosure' | 'news';

export interface NewsInsert {
  source: string;
  external_id: string;
  /** NOT NULL + enum. DART='disclosure', NAVER='news' */
  category: NewsCategory;
  title: string;
  url?: string | null;
  published_at: string | null; // ISO timestamp
  body?: string | null; // 네이버 description(snippet) 또는 DART 본문
  canonical_url?: string | null;
  status?: string; // collected | published | ...
  /** classify 세부 카테고리 (EARNINGS 등). 종목 연결은 news_stocks 사용 */
  subcategory?: string | null;
}

/** 파이프라인 결과로 news 행을 갱신할 때 쓰는 부분 업데이트 타입 */
export interface NewsUpdate {
  translated_title?: string;
  /**
   * SEO URL용 slug (영문 제목 기반). updateNews가 translated_title로부터
   * 자동 파생해 저장하므로 호출 측에서 직접 넘길 필요는 없다.
   */
  slug?: string | null;
  english_translation?: string;
  summary?: string;
  key_points?: string[];
  key_figures?: { label: string; value: string }[];
  subcategory?: string;
  related_stocks?: string[];
  confidence?: number;
  status?: string;
}

/** 중복 비교용으로 DB에서 조회하는 최근 뉴스 행 */
export interface RecentNewsRow {
  external_id: string;
  canonical_url: string | null;
  title: string;
  body: string | null;
  related_stocks: string[] | null;
}

// ===== Naver 뉴스 검색 API =====

export interface NaverNewsItem {
  title: string;
  originallink: string;
  link: string;
  description: string;
  pubDate: string; // RFC 1123
}

export interface NaverNewsResponse {
  items: NaverNewsItem[];
}

// ===== Claude 파이프라인 결과 =====

export interface ClassificationResult {
  decision: 'publish' | 'skip';
  related_stocks: string[];
  category: string;
  confidence: number;
  reason: string;
}

export interface NewsBriefResult {
  translated_title: string;
  summary: string;
  key_points: string[];
}

export interface DartTranslateResult {
  translated_title: string;
  english_translation: string;
  summary: string;
  key_figures: { label: string; value: string }[];
  key_points: string[];
}

// ===== 콘텐츠 다국어 번역 =====

/**
 * 콘텐츠 번역 대상 locale (PRD: 6개 언어 중 en 제외 5개).
 * en은 news 본체가 이미 영문이라 번역하지 않고, 그 외 locale은 영문 fallback.
 */
export const CONTENT_LOCALES = ['vi', 'ru', 'pt-BR', 'hi', 'uk'] as const;
export type ContentLocale = (typeof CONTENT_LOCALES)[number];

/** 주어진 locale이 번역 대상(화이트리스트)인지 */
export function isContentLocale(locale: string): locale is ContentLocale {
  return (CONTENT_LOCALES as readonly string[]).includes(locale);
}

/** 번역 파이프라인이 영문 입력을 받아 생성하는 결과(= 번역된 3필드) */
export interface TranslateContentResult {
  translated_title: string;
  summary: string;
  key_points: string[];
}

/** news_translations 행 (DB 저장 형태) */
export interface NewsTranslationRow {
  news_id: string;
  locale: ContentLocale;
  translated_title: string | null;
  summary: string | null;
  key_points: string[] | null;
  created_at?: string;
}

// ===== 처리 로그 =====

export type ProcessingStatus =
  | 'duplicate'
  | 'skipped'
  | 'filtered'
  | 'classification_publish'
  | 'classification_skip'
  | 'gpt_classification_failed'
  | 'gpt_brief_failed'
  | 'published'
  | 'disclosure_type_unconfirmed'
  | 'naver_cycle' // 비용 계측 메트릭 (cost_metric stage)
  | 'translate'; // 콘텐츠 번역 비용 계측 (cost_metric stage)

export interface ProcessingLogInsert {
  source: string;
  external_id: string;
  stage: string; // dedup | classification | brief | dart_translate
  status: ProcessingStatus;
  reason?: string | null;
  meta?: Record<string, unknown> | null;
}

// ===== Supabase: market_data 테이블 =====

export type MarketType = 'stock' | 'index' | 'fx';

export interface MarketDataUpsert {
  symbol: string;
  name: string;
  type: MarketType;
  price: number | null;
  change: number | null;
  change_percent: number | null;
  updated_at: string; // ISO timestamp
}

// ===== Price Gap Monitor =====

/**
 * 갭 측정 대상 거래소 (소문자 — perp 시세/OHLC 도메인).
 * 프리미엄 신청 도메인의 Exchange('BINANCE'|'BYBIT', 대문자)와 별개다.
 */
export type GapExchange = 'binance' | 'bybit';

/**
 * 한 시점(1초 tick)의 갭 계산 결과. (종목 × 거래소) 한 조합.
 * gap이 null이면 입력 중 하나가 누락/stale이라 계산 불가한 상태.
 */
export interface GapTick {
  ts: number; // epoch ms (계산 시각)
  stockCode: string; // '005930'
  exchange: GapExchange;
  krPrice: number | null; // 원화 체결가
  usdRef: number | null; // KR price / USDKRW
  exPrice: number | null; // 거래소 perp 가격(USDT)
  gap: number | null; // (exPrice - usdRef) / usdRef * 100
}

/** latest API가 내려주는, 한 (종목×거래소) 조합의 스냅샷 행 */
export interface GapSnapshotRow {
  stockCode: string;
  stockName: string;
  exchange: GapExchange;
  krPrice: number | null;
  usdRef: number | null;
  exPrice: number | null;
  gap: number | null;
  ts: number; // 이 값이 산출된 시각 (epoch ms)
}

/**
 * /latest 응답 행 = 실시간 스냅샷 + 과거평균(사전집계) 결합.
 *   pastAvgGap   : 전체 과거(All) 중 "현재 KST 분"의 close_gap 평균(%). 데이터 없으면 null.
 *   gapVsPastAvg : gap - pastAvgGap (percentage point). 둘 중 하나라도 null이면 null.
 */
export interface GapLatestRow extends GapSnapshotRow {
  pastAvgGap: number | null;
  gapVsPastAvg: number | null;
}

/** /chart 응답의 candle 1개 = OHLC + 선택 period 평균(avgGap). */
export interface GapChartCandle {
  timestamp_minute: string;
  stock_code: string;
  stock_name: string;
  exchange: GapExchange;
  open_gap: number;
  high_gap: number;
  low_gap: number;
  close_gap: number;
  avg_gap: number | null; // 1분 누산 평균(기존 저장값) — 차트 라인은 close 사용
  minuteOfDay: number; // KST hour*60+min (평균선 매칭 키)
  avgGap: number | null; // ★선택 period 같은 분 close_gap 평균(%). 데이터 없으면 null.
  availableDays: number | null; // ★해당 분 평균에 쓰인 거래일 수. period보다 적으면 "available data only"
}

/** price_gap_ohlc 테이블 1행 (1분 OHLC 집계) */
export interface GapOhlcRow {
  timestamp_minute: string; // ISO (분 경계)
  stock_code: string;
  stock_name: string;
  exchange: GapExchange;
  open_gap: number;
  high_gap: number;
  low_gap: number;
  close_gap: number;
  avg_gap: number | null; // 저장만, 차트는 close 사용
}

/**
 * price_gap_minute_avg 테이블 1행 (분당 평균 갭 사전집계).
 * (종목×거래소×minute_of_day×period)별 close_gap 평균.
 *   period=0  → 전체 과거(All), 테이블 Past Avg Gap용
 *   period=N  → 최근 N거래일(3/5/10/20/30), 차트 평균선용
 */
export interface GapMinuteAvgRow {
  stock_code: string;
  exchange: GapExchange;
  minute_of_day: number; // KST hour*60+min (장중 540~935)
  period: number; // 0=All / 3 / 5 / 10 / 20 / 30
  avg_close_gap: number; // 해당 (분,기간)의 close_gap 평균(%)
  available_days: number; // 실제 평균에 쓰인 distinct 거래일 수
}

// ===== Feature Flags (기능 노출 토글) =====

/**
 * 프론트 노출 제어용 flag 집합. 키가 없으면 false(미노출)로 간주.
 * MVP는 priceGapPublic 하나. 향후 key 추가 시 여기에 확장.
 */
export interface FeatureFlags {
  /** Price Gap Monitor 프론트 노출 여부 */
  priceGapPublic: boolean;
}

// ===== 한국투자증권(KIS) OpenAPI (주식/지수 현재가) =====

/** 국내주식 현재가 시세 응답 (inquire-price, TR FHKST01010100) */
export interface KisStockPriceResponse {
  rt_cd: string; // 0 정상
  msg_cd: string;
  msg1: string;
  output?: {
    stck_prpr: string; // 주식 현재가
    prdy_vrss: string; // 전일 대비
    prdy_vrss_sign: string; // 전일 대비 부호 (1상한 2상승 3보합 4하한 5하락)
    prdy_ctrt: string; // 전일 대비율
  };
}

/** 국내업종 현재지수 응답 (inquire-index-price, TR FHPUP02100000) */
export interface KisIndexPriceResponse {
  rt_cd: string; // 0 정상
  msg_cd: string;
  msg1: string;
  output?: {
    bstp_nmix_prpr: string; // 업종 지수 현재가
    bstp_nmix_prdy_vrss: string; // 업종 지수 전일 대비
    prdy_vrss_sign: string; // 전일 대비 부호
    bstp_nmix_prdy_ctrt: string; // 업종 지수 전일 대비율
  };
}

// ===== ExchangeRate-API (환율) =====

/** open.er-api.com/v6/latest/{base} 응답 */
export interface ErApiResponse {
  result: string; // "success" | "error"
  base_code?: string;
  time_last_update_utc?: string; // RFC1123
  rates?: Record<string, number>; // 통화코드 → 환율 (base 기준)
}

// ===== Bybit Affiliate API (V5) =====

/** aff-user-list 응답의 개별 레퍼럴 유저 */
export interface BybitAffiliateUser {
  userId: string;
  registerTime?: string;
  source?: string;
  isKyc?: boolean;
}

/** V5 표준 응답 래퍼 */
export interface BybitV5Response<T> {
  retCode: number;
  retMsg: string;
  result: T;
  time: number;
}

export interface BybitAffUserListResult {
  nextPageCursor: string;
  list: BybitAffiliateUser[];
}

/**
 * Bybit verify 결과 코드.
 * 프론트는 code로 i18n key를 매핑하고, message는 영어 fallback으로 사용한다.
 */
export type BybitVerifyCode =
  | 'BYBIT_VERIFY_OK' // 성공: premium 승격 완료
  | 'BYBIT_UID_REQUIRED' // bybitUid/userId 누락
  | 'BYBIT_UID_ALREADY_LINKED' // 다른 계정에 이미 연동된 UID
  | 'BYBIT_REFERRAL_NOT_FOUND' // 우리 레퍼럴 가입 내역 없음
  | 'BYBIT_USER_NOT_FOUND' // userId 없음
  | 'BYBIT_VERIFY_ERROR'; // 서버 오류

/** verify 엔드포인트 응답 */
export interface BybitVerifyResponse {
  success: boolean;
  /** 프론트 i18n key 매핑용 안정 코드 */
  code: BybitVerifyCode;
  /** 영어 fallback 메시지 (code 미매핑 시 노출) */
  message: string;
}

// ===== Binance UID 연동 (수동 승인) =====

/**
 * Binance UID 연동 상태.
 * not_applied → pending → approved | rejected
 * approved 전환은 Supabase 대시보드 + DB 트리거가 담당 (tier=premium 자동).
 */
export type BinanceUidStatus = 'not_applied' | 'pending' | 'approved' | 'rejected';

/**
 * Binance connect 결과 코드.
 * 프론트는 code로 i18n key를 매핑하고, message는 영어 fallback으로 사용한다.
 */
export type BinanceConnectCode =
  | 'BINANCE_CONNECT_OK' // 성공: 신청 접수(pending)
  | 'BINANCE_UID_REQUIRED' // binanceUid/userId 누락
  | 'BINANCE_UID_ALREADY_LINKED' // 다른 계정에 이미 연동된 UID
  | 'BINANCE_USER_NOT_FOUND' // userId 없음
  | 'BINANCE_CONNECT_ERROR'; // 서버 오류

/** connect 엔드포인트 응답 */
export interface BinanceConnectResponse {
  success: boolean;
  /** 프론트 i18n key 매핑용 안정 코드 */
  code: BinanceConnectCode;
  /** 영어 fallback 메시지 (code 미매핑 시 노출) */
  message: string;
}

// ===== 관리자 페이지 =====

/** API 표면의 회원등급 (DB tier: free/premium ↔ API: GENERAL/PREMIUM) */
export type ApiTier = 'GENERAL' | 'PREMIUM';

/** 회원 상태 (DB users.status). 활성 / 비활성(탈퇴) */
export type UserStatus = 'active' | 'inactive';

/** 거래소 UID 상태 (Binance/Bybit 공통, PRD 4종) */
export type UidStatus = 'not_applied' | 'pending' | 'approved' | 'rejected';

/** 거래소 식별자 */
export type Exchange = 'BINANCE' | 'BYBIT';

/**
 * 활동 로그 이벤트 타입 (activity_logs.type).
 * PRD 4.8 로그 기록 대상에 대응.
 */
export type ActivityLogType =
  | 'UID_APPLIED' // UID 신청
  | 'UID_APPROVED' // UID 승인
  | 'UID_REJECTED' // UID 거절
  | 'UID_CHANGE_REQUESTED' // UID 변경 신청
  | 'TIER_CHANGED' // 회원등급 변경
  | 'PREMIUM_AUTO_APPROVED' // 프리미엄 자동 승인
  | 'ADMIN_MANUAL_CHANGE'; // 관리자 수동 변경

/** activity_logs INSERT 페이로드 */
export interface ActivityLogInsert {
  user_id: string;
  type: ActivityLogType;
  exchange?: Exchange | null;
  uid?: string | null;
  from_tier?: string | null;
  to_tier?: string | null;
}

/** activity_logs 조회 행 (DB 컬럼 그대로) */
export interface ActivityLogRow {
  id: number;
  user_id: string;
  type: ActivityLogType;
  exchange: Exchange | null;
  uid: string | null;
  from_tier: string | null;
  to_tier: string | null;
  created_at: string;
}

/** 회원 리스트 아이템 (GET /internal/admin/users) */
export interface AdminUserListItem {
  userId: string;
  email: string;
  membershipTier: ApiTier;
  /** 승인된(approved) 거래소만. 예: ['BINANCE', 'BYBIT'] */
  approvedExchanges: Exchange[];
  createdAt: string;
  status: UserStatus;
}

/** 회원 상세의 거래소 UID 상태 */
export interface AdminExchangeUid {
  exchange: Exchange;
  uid: string | null;
  status: UidStatus;
}

/** 회원 상세 (GET /internal/admin/users/{userId}) */
export interface AdminUserDetail {
  userId: string;
  email: string;
  createdAt: string;
  membershipTier: ApiTier;
  status: UserStatus;
  exchangeUids: AdminExchangeUid[];
  activityLogs: AdminActivityLog[];
  adminMemo: string | null;
}

/** 활동 로그 응답 DTO (최신순) */
export interface AdminActivityLog {
  type: ActivityLogType;
  exchange?: Exchange | null;
  uid?: string | null;
  fromTier?: ApiTier | null;
  toTier?: ApiTier | null;
  createdAt: string;
}

// ===== 관리자 API 응답 래퍼 =====

export interface AdminLoginResponse {
  accessToken: string;
}

export interface AdminUserListResponse {
  users: AdminUserListItem[];
}

/** PATCH 결과 등 단순 응답 */
export interface AdminSimpleResponse {
  success: boolean;
  message: string;
}

/** JWT payload (관리자 토큰) */
export interface AdminJwtPayload {
  sub: string; // admins.id
  adminId: string; // admins.admin_id
}

// ===== 프리미엄 회원 신청 관리 =====

/** 신청 건 상태 (applications.status, PRD 4.2) */
export type ApplicationStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

/** 승인/거절 처리 입력 (PATCH .../status) — PENDING은 처리 대상이 아님 */
export type ApplicationAction = 'APPROVED' | 'REJECTED';

/** 프리미엄 신청 목록 아이템 (GET /internal/admin/premium-applications) */
export interface PremiumApplicationItem {
  applicationId: string;
  userId: string;
  email: string;
  exchange: Exchange;
  uid: string;
  membershipTier: ApiTier;
  status: ApplicationStatus;
  appliedAt: string;
}

export interface PremiumApplicationListResponse {
  items: PremiumApplicationItem[];
}

/** 승인/거절 성공 응답 */
export interface ProcessApplicationResponse {
  applicationId: string;
  status: ApplicationAction;
  processedAt: string;
}

/**
 * process_premium_application RPC 반환값 (jsonb).
 * ok=true면 처리 결과, ok=false면 reason으로 분기.
 */
export type ProcessApplicationRpcResult =
  | {
      ok: true;
      applicationId: string;
      status: ApplicationAction;
      processedAt: string;
    }
  | {
      ok: false;
      reason:
        | 'invalid_status'
        | 'not_found'
        | 'inactive_user'
        | 'already_processed';
    };

// ===== Korean's Hot News (관리자 직접 등록 + 예약 게시) =====

/** 핫뉴스 게시 상태 (DB hot_news.status, PRD 4.4) */
export type HotNewsStatus = 'scheduled' | 'published' | 'hidden';

/**
 * 핫뉴스 등록 입력 (POST). 관리자가 한국어로 title/content를 입력한다.
 * 영문 가공본(translated_title/summary/key_points)은 백엔드가 자동 생성한다.
 */
export interface HotNewsCreateInput {
  title: string;
  content: string;
  /** stocks.id 슬러그 배열(복수 선택). samsung/skhynix/hyundai 중 1개 이상 */
  relatedStock: string[];
  status: HotNewsStatus;
  /** ISO 8601. status='scheduled'일 때 필수 */
  scheduledAt?: string | null;
}

/**
 * 핫뉴스 상태 전환 입력 (PATCH). MVP는 내용 수정 불가 — 상태(+예약시각)만 변경한다.
 */
export interface HotNewsStatusPatch {
  status: HotNewsStatus;
  /** status='scheduled'로 전환 시 필수 */
  scheduledAt?: string | null;
}

/** hot_news 테이블 INSERT 페이로드 (영문 가공본 포함, snake_case) */
export interface HotNewsRowInsert {
  title: string;
  content: string;
  translated_title: string | null;
  summary: string | null;
  key_points: string[] | null;
  slug: string | null;
  stock_ids: string[];
  status: HotNewsStatus;
  scheduled_at: string | null;
  published_at: string | null;
}

/** 관리자 목록 아이템 (GET /internal/admin/hot-news) — 본문 미포함 */
export interface HotNewsListItem {
  id: string;
  seqId: number;
  title: string;
  relatedStock: string[];
  status: HotNewsStatus;
  scheduledAt: string | null;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 관리자 단건 (GET /internal/admin/hot-news/{id}) — 편집용 한국어 원문 본문 포함 */
export interface HotNewsDetail extends HotNewsListItem {
  /** 관리자가 입력한 한국어 원문 본문 */
  content: string;
}

/** 등록 성공 응답 */
export interface HotNewsCreateResponse {
  success: true;
  message: string;
  id: string;
}

export interface HotNewsListResponse {
  items: HotNewsListItem[];
}
