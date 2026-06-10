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
  | 'disclosure_type_unconfirmed';

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

/** verify 엔드포인트 응답 */
export interface BybitVerifyResponse {
  success: boolean;
  message: string;
}

// ===== Binance UID 연동 (수동 승인) =====

/**
 * Binance UID 연동 상태.
 * not_applied → pending → approved | rejected
 * approved 전환은 Supabase 대시보드 + DB 트리거가 담당 (tier=premium 자동).
 */
export type BinanceUidStatus = 'not_applied' | 'pending' | 'approved' | 'rejected';

/** connect 엔드포인트 응답 */
export interface BinanceConnectResponse {
  success: boolean;
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
