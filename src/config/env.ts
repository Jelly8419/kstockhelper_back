import dotenv from 'dotenv';

dotenv.config();

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`환경변수 ${name} 가 설정되지 않았습니다. .env 파일을 확인하세요.`);
  }
  return value;
}

/** 최소 길이를 강제하는 시크릿 환경변수. 짧으면 기동을 막아 약한 시크릿 배포를 방지한다. */
function requiredSecret(name: string, minLength: number): string {
  const value = required(name);
  if (value.length < minLength) {
    throw new Error(`환경변수 ${name} 는 최소 ${minLength}자 이상이어야 합니다. (현재 ${value.length}자)`);
  }
  return value;
}

/** boolean 환경변수 파싱. 미설정이면 기본값. 'false'/'0'/'no'/'off'만 false로 본다. */
function flag(name: string, defaultValue = true): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return defaultValue;
  return !['false', '0', 'no', 'off'].includes(v.trim().toLowerCase());
}

export const env = {
  supabaseUrl: required('SUPABASE_URL'),
  supabaseServiceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),
  dartApiKey: required('DART_API_KEY'),
  naverClientId: required('NAVER_CLIENT_ID'),
  naverClientSecret: required('NAVER_CLIENT_SECRET'),
  anthropicApiKey: required('ANTHROPIC_API_KEY'),
  /** 한국투자증권(KIS) OpenAPI 앱키/시크릿 (주식/지수 현재가 시세) */
  kisAppKey: required('KIS_APP_KEY'),
  kisAppSecret: required('KIS_APP_SECRET'),
  /** Bybit Affiliate API 키/시크릿 */
  bybitAffiliateApiKey: required('BYBIT_AFFILIATE_API_KEY'),
  bybitAffiliateApiSecret: required('BYBIT_AFFILIATE_API_SECRET'),
  /** 관리자 페이지 JWT 서명 시크릿 (일반 유저 인증과 분리). 최소 32자 강제. */
  jwtSecret: requiredSecret('JWT_SECRET', 32),
  /** /internal/admin/* 호출용 공유 시크릿 (프론트 서버만 보유). 최소 32자 강제. */
  internalApiSecret: requiredSecret('INTERNAL_API_SECRET', 32),
  /** 관리자 토큰 만료 (jsonwebtoken expiresIn 형식). 기본 8h */
  adminTokenTtl: process.env.ADMIN_TOKEN_TTL || '8h',
  /** 프론트엔드 URL (CORS 허용 origin) */
  frontendUrl: process.env.FRONTEND_URL || 'https://kstockhelper.com',
  /** 한 주기당 Claude classification 호출 상한 (비용/속도 제어) */
  maxClassifyPerRun: Number(process.env.MAX_CLASSIFY_PER_RUN) || 10,
  port: Number(process.env.PORT) || 3000,
  /**
   * Feature flags — Claude 비용이 발생하는 수집 잡 on/off.
   * 기본 true (운영은 영향 없음). 로컬에서 false로 두면 비용 발생 방지.
   */
  enableDart: flag('ENABLE_DART'),
  enableNaver: flag('ENABLE_NAVER'),
  /**
   * Price Gap Monitor — 한국주식 USD환산가 vs 거래소 perp 갭 수집/제공.
   * 기본 true. 로컬에서 KIS/거래소 WS를 띄우기 싫으면 false로 끈다.
   */
  enablePriceGap: flag('ENABLE_PRICE_GAP'),
  /** Basic 지연 노출 기준 (ms). PRD 10분 = 600_000. */
  priceGapBasicDelayMs: Number(process.env.PRICE_GAP_BASIC_DELAY_MS) || 600_000,
  /** 갭 계산/스냅샷 tick 주기 (ms). 1초. */
  priceGapTickMs: Number(process.env.PRICE_GAP_TICK_MS) || 1_000,
  /** FX(USDKRW) 폴링 주기 (ms). 장중 1분. */
  fxPollMs: Number(process.env.FX_POLL_MS) || 60_000,
  /** Binance WS 프레임 무수신 판정 시간 (ms) — 이 시간 내 0건이면 REST 폴백. */
  binanceWsProbeMs: Number(process.env.BINANCE_WS_PROBE_MS) || 5_000,
  /** Binance REST 폴백 폴링 주기 (ms). */
  binanceRestPollMs: Number(process.env.BINANCE_REST_POLL_MS) || 1_500,
  /**
   * Bybit REST 신선도 백업 폴링 주기 (ms). WS tickers는 체결 시에만 delta가 와서
   * 한산한 종목은 stale로 깜빡인다 → REST로 주기적 보강. WS가 주 경로라 5초면 충분.
   */
  bybitRestPollMs: Number(process.env.BYBIT_REST_POLL_MS) || 5_000,
  /**
   * 장외에도 Price Gap 수집을 강제로 켠다(로컬 테스트용). 기본 false.
   * true면 기동 시 시간창 무시하고 즉시 start. 운영에서는 켜지 말 것
   * (장외엔 KR 체결가가 없어 gap=null이고 불필요한 WS 연결을 유지하게 됨).
   */
  priceGapForceStart: flag('PRICE_GAP_FORCE_START', false),
};
