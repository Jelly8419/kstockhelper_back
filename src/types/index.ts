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
