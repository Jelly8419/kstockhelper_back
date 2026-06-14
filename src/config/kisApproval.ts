/**
 * 한국투자증권(KIS) WebSocket 접속키(approval_key) 발급.
 *
 * REST용 access_token(kisAuth.ts의 /oauth2/tokenP)과 **별개 체계**다:
 *   - 엔드포인트: POST /oauth2/Approval   (tokenP 아님)
 *   - body 시크릿 필드: secretkey          (REST는 appsecret — 필드명 함정 주의)
 *   - 산출물: approval_key                 (access_token 아님)
 *   - 같은 appkey/appsecret 사용 (신규 키 발급 불필요)
 *
 * approval_key는 WS 연결당 1회만 쓰고 재배포가 드물어 파일 캐시는 두지 않는다.
 * (access_token의 "1분당 1회" 발급 제한 이슈가 approval_key엔 핵심이 아님)
 * 메모리 캐시 + 동시호출 Promise 공유로 충분하다.
 */
import axios from 'axios';
import { env } from './env';
import { KIS_BASE } from './kisAuth';
import { logger } from '../utils/logger';

const APPROVAL_PATH = '/oauth2/Approval';

interface ApprovalResponse {
  approval_key?: string;
}

let cachedKey: string | null = null;
let inFlight: Promise<string> | null = null;

async function requestApprovalKey(): Promise<string> {
  const { data } = await axios.post<ApprovalResponse>(
    `${KIS_BASE}${APPROVAL_PATH}`,
    {
      grant_type: 'client_credentials',
      appkey: env.kisAppKey,
      secretkey: env.kisAppSecret, // 주의: REST tokenP는 appsecret, WS Approval은 secretkey
    },
    { headers: { 'Content-Type': 'application/json; charset=utf-8' }, timeout: 10_000 },
  );

  if (!data.approval_key) {
    throw new Error(`KIS approval_key 응답 없음: ${JSON.stringify(data)}`);
  }
  cachedKey = data.approval_key;
  logger.info('KIS approval_key 발급 완료');
  return cachedKey;
}

/**
 * 유효한 approval_key를 반환한다. 메모리 캐시 우선, 없으면 발급(동시호출 1회 공유).
 * @param forceRefresh 재연결 시 키 만료가 의심되면 true로 강제 재발급.
 */
export async function getKisApprovalKey(forceRefresh = false): Promise<string> {
  if (!forceRefresh && cachedKey) return cachedKey;
  if (forceRefresh) cachedKey = null;
  if (inFlight) return inFlight;
  inFlight = requestApprovalKey().finally(() => {
    inFlight = null;
  });
  return inFlight;
}
