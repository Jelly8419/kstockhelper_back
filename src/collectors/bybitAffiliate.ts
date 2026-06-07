import crypto from 'crypto';
import axios from 'axios';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { getLinkedBybitUsers, upgradeToPremium } from '../services/users.service';
import type {
  BybitV5Response,
  BybitAffUserListResult,
  BybitAffiliateUser,
} from '../types';

const BYBIT_BASE = 'https://api.bybit.com';
const AFF_USER_LIST_PATH = '/v5/affiliate/aff-user-list';
const RECV_WINDOW = '5000';
const PAGE_SIZE = 100; // aff-user-list size 상한
const MAX_PAGES = 100; // 무한루프 방지 (최대 1만명)

/**
 * Bybit V5 GET 서명.
 * sign = HMAC_SHA256(secret, timestamp + apiKey + recvWindow + queryString)
 */
function sign(timestamp: string, queryString: string): string {
  const payload = timestamp + env.bybitAffiliateApiKey + RECV_WINDOW + queryString;
  return crypto.createHmac('sha256', env.bybitAffiliateApiSecret).update(payload).digest('hex');
}

/** 쿼리 객체 → 정렬되지 않은 순서 그대로의 쿼리스트링 (서명/요청 동일하게 사용) */
function buildQuery(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

/** 단일 페이지 조회 */
async function fetchPage(cursor: string): Promise<BybitAffUserListResult> {
  const params: Record<string, string> = { size: String(PAGE_SIZE) };
  if (cursor) params.cursor = cursor;

  const queryString = buildQuery(params);
  const timestamp = String(Date.now());
  const signature = sign(timestamp, queryString);

  const { data } = await axios.get<BybitV5Response<BybitAffUserListResult>>(
    `${BYBIT_BASE}${AFF_USER_LIST_PATH}?${queryString}`,
    {
      headers: {
        'X-BAPI-API-KEY': env.bybitAffiliateApiKey,
        'X-BAPI-TIMESTAMP': timestamp,
        'X-BAPI-RECV-WINDOW': RECV_WINDOW,
        'X-BAPI-SIGN': signature,
      },
      timeout: 10_000,
    },
  );

  if (data.retCode !== 0) {
    throw new Error(`Bybit API 오류 (retCode=${data.retCode}): ${data.retMsg}`);
  }
  return data.result;
}

/**
 * 전체 레퍼럴 유저를 cursor 순회로 수집한다.
 * (aff-user-list는 UID 단건 조회를 지원하지 않음)
 */
export async function fetchAllAffiliateUsers(): Promise<BybitAffiliateUser[]> {
  const all: BybitAffiliateUser[] = [];
  let cursor = '';

  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await fetchPage(cursor);
    all.push(...(result.list ?? []));

    cursor = result.nextPageCursor ?? '';
    if (!cursor || (result.list?.length ?? 0) < PAGE_SIZE) break;
  }

  return all;
}

/**
 * 특정 UID가 우리 레퍼럴 목록에 있는지 확인한다.
 * 목록에 존재하면 우리 레퍼럴 가입자.
 */
export async function findAffiliateUser(uid: string): Promise<BybitAffiliateUser | null> {
  let cursor = '';

  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await fetchPage(cursor);
    const found = (result.list ?? []).find((u) => u.userId === uid);
    if (found) return found;

    cursor = result.nextPageCursor ?? '';
    if (!cursor || (result.list?.length ?? 0) < PAGE_SIZE) break;
  }

  return null;
}

/** 전체 레퍼럴 UID 집합 (스케줄러 재확인용) */
export async function fetchAffiliateUidSet(): Promise<Set<string>> {
  try {
    const users = await fetchAllAffiliateUsers();
    return new Set(users.map((u) => u.userId));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Bybit 레퍼럴 전체 조회 실패:', msg);
    throw err;
  }
}

/**
 * 1일 1회 동기화 (스케줄러).
 * 이미 bybit_uid가 연결된 유저들이 여전히 레퍼럴 목록에 있는지 재확인하고,
 * premium이 아니면 다시 premium으로 유지/승격한다.
 * (verify를 한 번도 안 한 유저는 매칭 불가 — 결정에 따라 자동 승격 대상 아님)
 */
export async function syncAffiliateUsers(): Promise<void> {
  const uidSet = await fetchAffiliateUidSet();
  const linked = await getLinkedBybitUsers();

  let reconfirmed = 0;
  let missing = 0;

  for (const u of linked) {
    if (uidSet.has(u.bybit_uid)) {
      // 레퍼럴 유지 중 — premium 아니면 재승격
      if (u.tier !== 'premium') {
        await upgradeToPremium(u.id, u.bybit_uid);
        reconfirmed++;
      }
    } else {
      // 레퍼럴 목록에서 빠짐 — 강등은 정책 미정이라 로그만 남김
      missing++;
      logger.warn(`연동 유저가 레퍼럴 목록에 없음 — userId=${u.id}, bybitUid=${u.bybit_uid}`);
    }
  }

  logger.info(
    `Bybit 동기화 완료 — 레퍼럴 ${uidSet.size}명 / 연동 ${linked.length}명 / 재승격 ${reconfirmed} / 누락 ${missing}`,
  );
}
