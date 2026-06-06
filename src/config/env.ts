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
  /** 한 주기당 Claude classification 호출 상한 (비용/속도 제어) */
  maxClassifyPerRun: Number(process.env.MAX_CLASSIFY_PER_RUN) || 10,
  port: Number(process.env.PORT) || 3000,
};
