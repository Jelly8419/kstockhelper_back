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

// ===== 금융위원회 공공데이터 API (주식/지수) =====

/** getStockPriceInfo / getStockMarketIndex 공통 응답 item 일부 */
export interface PublicMarketItem {
  basDt: string; // 기준일자 YYYYMMDD
  clpr?: string; // 종가 (주식)
  clpr_idx?: string; // (지수는 clpr 동일 필드명 사용)
  vs?: string; // 전일 대비
  fltRt?: string; // 등락률
  srtnCd?: string; // 단축 종목코드 (주식)
  itmsNm?: string; // 종목명 (주식)
  idxNm?: string; // 지수명 (지수)
}

/** 공공데이터포털 표준 응답 래퍼 (resultType=json) */
export interface PublicDataResponse<T> {
  response: {
    header: { resultCode: string; resultMsg: string };
    body: {
      numOfRows: number;
      pageNo: number;
      totalCount: number;
      items: { item: T[] } | '';
    };
  };
}

// ===== 한국은행 ECOS API (환율) =====

export interface EcosRow {
  STAT_CODE: string;
  ITEM_CODE1: string;
  TIME: string; // YYYYMMDD
  DATA_VALUE: string; // 환율 값
}

export interface EcosResponse {
  StatisticSearch?: {
    list_total_count: number;
    row: EcosRow[];
  };
  RESULT?: { CODE: string; MESSAGE: string };
}
