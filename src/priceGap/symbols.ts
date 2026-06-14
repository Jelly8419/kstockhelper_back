/**
 * Price Gap Monitor — 종목 ↔ 거래소 perp 심볼 매핑.
 *
 * 한국 종목코드(6자리)를 Binance/Bybit의 한국주식 연계 무기한선물 심볼에 매핑한다.
 * Binance·Bybit 모두 동일 네이밍(SAMSUNGUSDT 등)이라 거래소별 분기가 불필요하다.
 * (PoC 검증: claudedocs/price_gap_monitor_poc_report.md)
 *
 * stocks.ts(뉴스/DART 핫패스가 의존)를 건드리지 않도록 여기서 파생 매핑만 둔다.
 */
import { STOCKS } from '../constants/stocks';
import type { GapExchange } from '../types';

/** 6자리 종목코드 → perp 심볼 (Binance·Bybit 공통) */
const PERP_SYMBOL_BY_CODE: Record<string, string> = {
  '005930': 'SAMSUNGUSDT', // 삼성전자
  '000660': 'SKHYNIXUSDT', // SK하이닉스
  '005380': 'HYUNDAIUSDT', // 현대차
};

/** 갭 측정 대상 거래소 (단일 선택 필터의 허용 집합과 일치) */
export const EXCHANGES: readonly GapExchange[] = ['binance', 'bybit'];

/** 갭 측정 대상 종목 메타 (stocks.ts STOCKS에서 perp 심볼 보유분만 파생) */
export interface GapStockMeta {
  code: string; // '005930'
  name: string; // '삼성전자'
  perpSymbol: string; // 'SAMSUNGUSDT'
}

export const GAP_STOCKS: readonly GapStockMeta[] = STOCKS.filter(
  (s) => PERP_SYMBOL_BY_CODE[s.code],
).map((s) => ({
  code: s.code,
  name: s.name,
  perpSymbol: PERP_SYMBOL_BY_CODE[s.code],
}));

/** 종목코드 → perp 심볼 (없으면 undefined) */
export function perpSymbolOf(code: string): string | undefined {
  return PERP_SYMBOL_BY_CODE[code];
}

/** perp 심볼 → 종목코드 역매핑 (거래소 WS 수신 시 코드 환원용) */
export const CODE_BY_PERP_SYMBOL: Record<string, string> = Object.fromEntries(
  Object.entries(PERP_SYMBOL_BY_CODE).map(([code, sym]) => [sym, code]),
);

/** 갭 측정 대상 6자리 종목코드 배열 (KIS WS 구독용) */
export const GAP_STOCK_CODES: readonly string[] = GAP_STOCKS.map((s) => s.code);

/** 갭 측정 대상 perp 심볼 배열 (거래소 WS 구독용) */
export const GAP_PERP_SYMBOLS: readonly string[] = GAP_STOCKS.map((s) => s.perpSymbol);
