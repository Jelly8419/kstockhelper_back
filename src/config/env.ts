import dotenv from 'dotenv';

dotenv.config();

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`환경변수 ${name} 가 설정되지 않았습니다. .env 파일을 확인하세요.`);
  }
  return value;
}

export const env = {
  supabaseUrl: required('SUPABASE_URL'),
  supabaseServiceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),
  dartApiKey: required('DART_API_KEY'),
  naverClientId: required('NAVER_CLIENT_ID'),
  naverClientSecret: required('NAVER_CLIENT_SECRET'),
  anthropicApiKey: required('ANTHROPIC_API_KEY'),
  /** 공공데이터포털 인증키 (금융위 주식/지수 시세) */
  publicDataApiKey: required('PUBLIC_DATA_API_KEY'),
  /** 한국은행 ECOS 인증키 (환율) */
  bokApiKey: required('BOK_API_KEY'),
  /** Bybit Affiliate API 키/시크릿 */
  bybitAffiliateApiKey: required('BYBIT_AFFILIATE_API_KEY'),
  bybitAffiliateApiSecret: required('BYBIT_AFFILIATE_API_SECRET'),
  /** 프론트엔드 URL (CORS 허용 origin) */
  frontendUrl: process.env.FRONTEND_URL || 'https://kstockhelper.com',
  /** 한 주기당 Claude classification 호출 상한 (비용/속도 제어) */
  maxClassifyPerRun: Number(process.env.MAX_CLASSIFY_PER_RUN) || 10,
  port: Number(process.env.PORT) || 3000,
};
