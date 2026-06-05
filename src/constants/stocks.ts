/**
 * 수집 대상 종목 메타데이터.
 *
 * corpCode: DART 고유번호(8자리). DART OpenAPI(list.json)로 직접 검증한 값.
 *   - 005930 삼성전자  → 00126380
 *   - 000660 SK하이닉스 → 00164779
 *   - 005380 현대자동차 → 00164742
 * 새 종목 추가 시 DART corpCode.xml 또는 list.json으로 corpCode를 확인할 것.
 */
export interface StockMeta {
  /** stocks 테이블 PK (text 슬러그). news_stocks.stock_id 에 사용 */
  stockId: string;
  name: string;
  /** 영문 종목명 (Claude classification의 related_stocks 매핑용) */
  nameEn: string;
  /** 6자리 한국 종목코드 */
  code: string;
  /** DART 고유번호 (8자리) */
  corpCode: string;
  /** Yahoo Finance 심볼 */
  yahooSymbol: string;
}

export const STOCKS: StockMeta[] = [
  {
    stockId: 'samsung',
    name: '삼성전자',
    nameEn: 'Samsung Electronics',
    code: '005930',
    corpCode: '00126380',
    yahooSymbol: '005930.KS',
  },
  {
    stockId: 'skhynix',
    name: 'SK하이닉스',
    nameEn: 'SK Hynix',
    code: '000660',
    corpCode: '00164779',
    yahooSymbol: '000660.KS',
  },
  {
    stockId: 'hyundai',
    name: '현대차',
    nameEn: 'Hyundai Motor',
    code: '005380',
    corpCode: '00164742',
    yahooSymbol: '005380.KS',
  },
];

/** 영문 종목명 → stocks.id 슬러그 매핑 (classification related_stocks 역매핑용) */
export const STOCK_ID_BY_NAME_EN: Record<string, string> = Object.fromEntries(
  STOCKS.map((s) => [s.nameEn, s.stockId]),
);

/** 6자리 종목코드 → stocks.id 슬러그 매핑 (DART stock_code 역매핑용) */
export const STOCK_ID_BY_CODE: Record<string, string> = Object.fromEntries(
  STOCKS.map((s) => [s.code, s.stockId]),
);

/** 시장 지수 / 환율 (Yahoo Finance 전용, DART 수집 대상 아님) */
export interface IndexMeta {
  name: string;
  yahooSymbol: string;
  type: 'index' | 'fx';
}

export const INDICES: IndexMeta[] = [
  { name: 'KOSPI', yahooSymbol: '^KS11', type: 'index' },
  { name: 'KOSDAQ', yahooSymbol: '^KQ11', type: 'index' },
  { name: 'USD/KRW', yahooSymbol: 'KRW=X', type: 'fx' },
];
