import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { supabase } from '../config/supabase';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import type {
  ActivityLogInsert,
  ActivityLogRow,
  AdminActivityLog,
  AdminExchangeUid,
  AdminJwtPayload,
  AdminUserDetail,
  AdminUserListItem,
  ApiTier,
  Exchange,
  UidStatus,
  UserStatus,
} from '../types';

// ===== tier 매핑 (DB free/premium ↔ API GENERAL/PREMIUM) =====

/** DB tier 문자열 → API 등급. 'premium'만 PREMIUM, 그 외(free 등)는 GENERAL */
export function toApiTier(dbTier: string | null | undefined): ApiTier {
  return dbTier === 'premium' ? 'PREMIUM' : 'GENERAL';
}

/** API 등급 → DB tier 문자열 */
export function toDbTier(apiTier: ApiTier): string {
  return apiTier === 'PREMIUM' ? 'premium' : 'free';
}

// ===== 관리자 인증 =====

interface AdminRow {
  id: string;
  admin_id: string;
  password_hash: string;
}

/**
 * adminId/password 검증. 성공 시 admin 행, 실패(미존재/불일치) 시 null.
 * 타이밍 공격 완화를 위해 미존재 시에도 더미 해시로 bcrypt 비교를 수행한다.
 */
export async function verifyAdminCredentials(
  adminId: string,
  password: string,
): Promise<AdminRow | null> {
  const { data, error } = await supabase
    .from('admins')
    .select('id, admin_id, password_hash')
    .eq('admin_id', adminId)
    .limit(1);

  if (error) {
    logger.error('admins 조회 실패:', error.message);
    throw error;
  }

  const admin = data?.[0] as AdminRow | undefined;
  // 사용자 열거/타이밍 차이 완화: 미존재여도 비교 비용을 동일하게 지불
  const hash = admin?.password_hash ?? '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinva';
  const ok = await bcrypt.compare(password, hash);

  if (!admin || !ok) return null;
  return admin;
}

/** 관리자 JWT 발급 */
export function issueAdminToken(admin: AdminRow): string {
  const payload: AdminJwtPayload = { sub: admin.id, adminId: admin.admin_id };
  // @types/jsonwebtoken v9는 expiresIn을 브랜드 StringValue로 좁혀 env의 plain string을
  // 거부한다. 런타임은 '8h' 같은 문자열을 정상 처리하므로 SignOptions로 캐스팅.
  const options = { expiresIn: env.adminTokenTtl } as jwt.SignOptions;
  return jwt.sign(payload, env.jwtSecret, options);
}

/** 토큰 검증. 유효하면 payload, 무효/만료면 null */
export function verifyAdminToken(token: string): AdminJwtPayload | null {
  try {
    const decoded = jwt.verify(token, env.jwtSecret);
    if (typeof decoded === 'string') return null;
    const { sub, adminId } = decoded as Record<string, unknown>;
    if (typeof sub !== 'string' || typeof adminId !== 'string') return null;
    return { sub, adminId };
  } catch {
    return null;
  }
}

// ===== 활동 로그 =====

/** 활동 로그 1건 기록 (실패해도 본 작업을 막지 않도록 호출부에서 try/catch 권장) */
export async function appendActivityLog(entry: ActivityLogInsert): Promise<void> {
  const { error } = await supabase.from('activity_logs').insert({
    user_id: entry.user_id,
    type: entry.type,
    exchange: entry.exchange ?? null,
    uid: entry.uid ?? null,
    from_tier: entry.from_tier ?? null,
    to_tier: entry.to_tier ?? null,
  });
  if (error) {
    logger.error('activity_logs 기록 실패:', error.message);
    throw error;
  }
}

/** 특정 회원의 활동 로그를 최신순으로 조회 → API DTO 변환 */
export async function getActivityLogs(userId: string): Promise<AdminActivityLog[]> {
  const { data, error } = await supabase
    .from('activity_logs')
    .select('id, user_id, type, exchange, uid, from_tier, to_tier, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false });

  if (error) {
    logger.error('activity_logs 조회 실패:', error.message);
    throw error;
  }

  return (data as ActivityLogRow[] | null ?? []).map((r) => ({
    type: r.type,
    exchange: r.exchange,
    uid: r.uid,
    // 등급 로그는 DB tier 문자열로 저장되므로 API 등급으로 변환
    fromTier: r.from_tier ? toApiTier(r.from_tier) : null,
    toTier: r.to_tier ? toApiTier(r.to_tier) : null,
    createdAt: r.created_at,
  }));
}

// ===== 회원 조회 =====

interface UserRow {
  id: string;
  email: string;
  tier: string | null;
  status: string | null;
  created_at: string;
  binance_uid: string | null;
  binance_uid_status: string | null;
  bybit_uid: string | null;
  bybit_uid_status: string | null;
  admin_memo: string | null;
}

const USER_SELECT =
  'id, email, tier, status, created_at, binance_uid, binance_uid_status, bybit_uid, bybit_uid_status, admin_memo';

function normalizeStatus(s: string | null): UserStatus {
  return s === 'inactive' ? 'inactive' : 'active';
}

function normalizeUidStatus(s: string | null): UidStatus {
  if (s === 'pending' || s === 'approved' || s === 'rejected') return s;
  return 'not_applied';
}

/** approved 상태인 거래소만 배열로 (PRD 4.3 거래소 컬럼 규칙) */
function approvedExchanges(u: UserRow): Exchange[] {
  const out: Exchange[] = [];
  if (normalizeUidStatus(u.binance_uid_status) === 'approved') out.push('BINANCE');
  if (normalizeUidStatus(u.bybit_uid_status) === 'approved') out.push('BYBIT');
  return out;
}

/** 회원 리스트 (가입일 최신순). 탈퇴(inactive) 회원도 포함 */
export async function listUsers(): Promise<AdminUserListItem[]> {
  const { data, error } = await supabase
    .from('users')
    .select(USER_SELECT)
    .order('created_at', { ascending: false });

  if (error) {
    logger.error('회원 리스트 조회 실패:', error.message);
    throw error;
  }

  return (data as UserRow[] | null ?? []).map((u) => ({
    userId: u.id,
    email: u.email,
    membershipTier: toApiTier(u.tier),
    approvedExchanges: approvedExchanges(u),
    createdAt: u.created_at,
    status: normalizeStatus(u.status),
  }));
}

/** 회원 상세. 미존재 시 null */
export async function getUserDetail(userId: string): Promise<AdminUserDetail | null> {
  const { data, error } = await supabase
    .from('users')
    .select(USER_SELECT)
    .eq('id', userId)
    .limit(1);

  if (error) {
    logger.error('회원 상세 조회 실패:', error.message);
    throw error;
  }

  const u = data?.[0] as UserRow | undefined;
  if (!u) return null;

  const exchangeUids: AdminExchangeUid[] = [
    { exchange: 'BINANCE', uid: u.binance_uid, status: normalizeUidStatus(u.binance_uid_status) },
    { exchange: 'BYBIT', uid: u.bybit_uid, status: normalizeUidStatus(u.bybit_uid_status) },
  ];

  const activityLogs = await getActivityLogs(userId);

  return {
    userId: u.id,
    email: u.email,
    createdAt: u.created_at,
    membershipTier: toApiTier(u.tier),
    status: normalizeStatus(u.status),
    exchangeUids,
    activityLogs,
    adminMemo: u.admin_memo,
  };
}

/** 회원 존재 여부 + 현재 tier 조회 (등급 변경 전 확인용) */
async function getUserTier(userId: string): Promise<{ exists: boolean; dbTier: string | null }> {
  const { data, error } = await supabase.from('users').select('tier').eq('id', userId).limit(1);
  if (error) {
    logger.error('회원 tier 조회 실패:', error.message);
    throw error;
  }
  if (!data || data.length === 0) return { exists: false, dbTier: null };
  return { exists: true, dbTier: (data[0] as { tier: string | null }).tier };
}

export type ChangeTierResult =
  | { ok: true; changed: boolean }
  | { ok: false; reason: 'not_found' };

/**
 * 회원등급 수동 변경. UID 상태는 건드리지 않는다(PRD 4.5).
 * 동일 등급이면 변경 없이 changed=false 반환 (멱등).
 * 실제 변경 시 activity_logs에 TIER_CHANGED + ADMIN_MANUAL_CHANGE 컨텍스트를 기록한다.
 */
export async function changeMembershipTier(
  userId: string,
  apiTier: ApiTier,
): Promise<ChangeTierResult> {
  const { exists, dbTier } = await getUserTier(userId);
  if (!exists) return { ok: false, reason: 'not_found' };

  const nextDbTier = toDbTier(apiTier);
  if (dbTier === nextDbTier) {
    // 이미 동일 등급 — DB 변경/로그 없이 멱등 처리
    return { ok: true, changed: false };
  }

  const { error } = await supabase.from('users').update({ tier: nextDbTier }).eq('id', userId);
  if (error) {
    logger.error('회원등급 변경 실패:', error.message);
    throw error;
  }

  // 등급 변경 로그 (관리자 수동 변경)
  await appendActivityLog({
    user_id: userId,
    type: 'TIER_CHANGED',
    from_tier: dbTier,
    to_tier: nextDbTier,
  });

  logger.info(`회원등급 변경 — userId=${userId}, ${dbTier} → ${nextDbTier} (관리자 수동)`);
  return { ok: true, changed: true };
}

/** 관리자 메모 최대 길이 (PRD 4.10) */
export const ADMIN_MEMO_MAX = 1000;

export type SaveMemoResult = { ok: true } | { ok: false; reason: 'not_found' };

/** 관리자 메모 저장. 미존재 시 not_found */
export async function saveMemo(userId: string, memo: string): Promise<SaveMemoResult> {
  const { data, error } = await supabase
    .from('users')
    .update({ admin_memo: memo })
    .eq('id', userId)
    .select('id');

  if (error) {
    logger.error('관리자 메모 저장 실패:', error.message);
    throw error;
  }
  if (!data || data.length === 0) return { ok: false, reason: 'not_found' };
  return { ok: true };
}
