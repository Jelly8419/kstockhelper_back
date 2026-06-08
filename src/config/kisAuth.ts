import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { env } from './env';
import { logger } from '../utils/logger';

/**
 * 한국투자증권(KIS) OpenAPI OAuth 토큰 관리.
 *
 * - /oauth2/tokenP 로 access_token 발급 (grant_type=client_credentials).
 * - 토큰 유효기간은 24시간. 한투는 "토큰 발급 1분당 1회" 제한이 있어, 매 호출/재시작마다
 *   재발급하면 EGW00133(403)으로 막힌다. 따라서:
 *     1) 메모리 캐싱 (프로세스 생존 중 재사용)
 *     2) 파일 캐싱 (프로세스 재시작/재배포 시에도 유효 토큰 재사용 → 1분 제한 회피)
 * - 만료 임박(SAFETY_WINDOW_MS) 시 재발급.
 * - 동시 호출 중복 발급을 막기 위해 발급 중인 Promise를 공유한다.
 */

interface TokenResponse {
  access_token: string;
  token_type: string;
  /** 초 단위 만료까지 남은 시간 (보통 86400) */
  expires_in: number;
  /** "yyyy-MM-dd HH:mm:ss" 형식 만료 시각 */
  access_token_token_expired?: string;
}

/** 파일 캐시에 저장하는 형태 */
interface CachedToken {
  token: string;
  expiresAt: number; // epoch ms
}

/** 실전투자 도메인 (모의투자는 openapivts.koreainvestment.com:29443) */
const KIS_BASE = 'https://openapi.koreainvestment.com:9443';

/** 만료 60초 전엔 미리 재발급 (경계 시점 호출 실패 방지) */
const SAFETY_WINDOW_MS = 60_000;

/** 토큰 파일 캐시 경로 (프로젝트 루트). .gitignore 등록 필수. */
const TOKEN_CACHE_PATH = path.resolve(process.cwd(), '.kis-token.json');

let cachedToken: string | null = null;
/** 캐시 토큰 만료 시각 (epoch ms). 이 시각 - SAFETY_WINDOW 전까지만 유효로 본다. */
let tokenExpiresAt = 0;
/** 발급 진행 중인 Promise (동시 호출 중복 발급 방지) */
let inFlight: Promise<string> | null = null;

/** 파일 캐시에서 토큰 로드. 없거나 손상 시 null. */
function loadFromFile(): CachedToken | null {
  try {
    if (!fs.existsSync(TOKEN_CACHE_PATH)) return null;
    const raw = fs.readFileSync(TOKEN_CACHE_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as CachedToken;
    if (!parsed.token || !parsed.expiresAt) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** 파일 캐시에 토큰 저장 (실패해도 치명적이지 않음 — 메모리 캐시로 동작). */
function saveToFile(data: CachedToken): void {
  try {
    fs.writeFileSync(TOKEN_CACHE_PATH, JSON.stringify(data), 'utf-8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('KIS 토큰 파일 캐시 저장 실패(메모리 캐시로 계속):', msg);
  }
}

/** 토큰이 유효(만료 여유 포함)한지 판정 */
function isValid(expiresAt: number): boolean {
  return Date.now() < expiresAt - SAFETY_WINDOW_MS;
}

/** 실제 토큰 발급 요청. */
async function requestToken(): Promise<string> {
  const { data } = await axios.post<TokenResponse>(
    `${KIS_BASE}/oauth2/tokenP`,
    {
      grant_type: 'client_credentials',
      appkey: env.kisAppKey,
      appsecret: env.kisAppSecret,
    },
    {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10_000,
    },
  );

  if (!data.access_token) {
    throw new Error('KIS 토큰 응답에 access_token 없음');
  }

  cachedToken = data.access_token;
  // expires_in(초) 기준으로 만료 시각 계산. 없으면 보수적으로 23시간.
  const ttlMs = (data.expires_in ? data.expires_in : 23 * 60 * 60) * 1000;
  tokenExpiresAt = Date.now() + ttlMs;
  saveToFile({ token: cachedToken, expiresAt: tokenExpiresAt });
  logger.info(`KIS access_token 발급 완료 (만료까지 ${Math.round(ttlMs / 1000 / 60)}분)`);

  return cachedToken;
}

/**
 * 유효한 KIS access_token을 반환한다.
 * 우선순위: 메모리 캐시 → 파일 캐시 → 신규 발급.
 */
export async function getKisToken(): Promise<string> {
  // 1) 메모리 캐시
  if (cachedToken && isValid(tokenExpiresAt)) {
    return cachedToken;
  }

  // 2) 파일 캐시 (프로세스 재시작 직후) — 유효하면 메모리로 끌어올려 재사용
  const fileCache = loadFromFile();
  if (fileCache && isValid(fileCache.expiresAt)) {
    cachedToken = fileCache.token;
    tokenExpiresAt = fileCache.expiresAt;
    return cachedToken;
  }

  // 3) 신규 발급 (동시 호출은 Promise 공유로 1회만)
  if (inFlight) return inFlight;
  inFlight = requestToken().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** 공통 KIS 요청 헤더 구성 (조회용). tr_id는 API별로 다르므로 인자로 받는다. */
export async function kisHeaders(trId: string): Promise<Record<string, string>> {
  const token = await getKisToken();
  return {
    'Content-Type': 'application/json; charset=utf-8',
    authorization: `Bearer ${token}`,
    appkey: env.kisAppKey,
    appsecret: env.kisAppSecret,
    tr_id: trId,
    custtype: 'P', // 개인
  };
}

export { KIS_BASE };
