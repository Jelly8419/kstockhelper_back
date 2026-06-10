import { supabase } from '../config/supabase';
import { logger } from '../utils/logger';

/**
 * 유저를 premium으로 승격하고 bybit_uid를 연결한다.
 * @returns 업데이트된 행 존재 여부 (해당 userId가 없으면 false)
 */
export async function upgradeToPremium(userId: string, bybitUid: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('users')
    // Bybit는 레퍼럴 자동 검증이라 연결 즉시 approved (PRD 4종 상태 반영)
    .update({ tier: 'premium', bybit_uid: bybitUid, bybit_uid_status: 'approved' })
    .eq('id', userId)
    .select('id');

  if (error) {
    logger.error('users premium 승격 실패:', error.message);
    throw error;
  }
  return (data?.length ?? 0) > 0;
}

/** bybit_uid가 이미 연결된 유저 목록 (스케줄러 재확인용) */
export async function getLinkedBybitUsers(): Promise<{ id: string; bybit_uid: string; tier: string }[]> {
  const { data, error } = await supabase
    .from('users')
    .select('id, bybit_uid, tier')
    .not('bybit_uid', 'is', null);

  if (error) {
    logger.error('연동 유저 조회 실패:', error.message);
    throw error;
  }
  return (data ?? []) as { id: string; bybit_uid: string; tier: string }[];
}

/** 특정 bybit_uid가 이미 다른 유저에 연결돼 있는지 확인 (중복 연결 방지) */
export async function findUserByBybitUid(bybitUid: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('users')
    .select('id')
    .eq('bybit_uid', bybitUid)
    .limit(1);

  if (error) {
    logger.error('bybit_uid 조회 실패:', error.message);
    throw error;
  }
  return data && data.length > 0 ? String(data[0].id) : null;
}

/** 유저 tier를 강등 (스케줄러: 레퍼럴 목록에서 빠진 경우 사용 가능 — 현재는 미사용) */
export async function setTier(userId: string, tier: string): Promise<void> {
  const { error } = await supabase.from('users').update({ tier }).eq('id', userId);
  if (error) {
    logger.error('users tier 변경 실패:', error.message);
    throw error;
  }
}

// ===== Binance UID 연동 (수동 승인) =====

/**
 * Binance UID를 연결하고 상태를 pending으로 변경한다 (승인 신청).
 * 실제 승인(approved → tier=premium)은 Supabase 대시보드 + DB 트리거가 담당.
 * @returns 업데이트된 행 존재 여부 (해당 userId가 없으면 false)
 */
export async function connectBinanceUid(userId: string, binanceUid: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('users')
    .update({ binance_uid: binanceUid, binance_uid_status: 'pending' })
    .eq('id', userId)
    .select('id');

  if (error) {
    logger.error('Binance UID 연결 실패:', error.message);
    throw error;
  }
  return (data?.length ?? 0) > 0;
}

/** 특정 binance_uid가 이미 다른 유저에 연결돼 있는지 확인 (중복 연동 방지) */
export async function findUserByBinanceUid(binanceUid: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('users')
    .select('id')
    .eq('binance_uid', binanceUid)
    .limit(1);

  if (error) {
    logger.error('binance_uid 조회 실패:', error.message);
    throw error;
  }
  return data && data.length > 0 ? String(data[0].id) : null;
}

/**
 * 신청 이력(applications)에 PENDING row를 추가한다.
 * UID 입력/변경마다 새 row가 쌓여 history로 보존된다(PRD 4.2).
 */
export async function insertApplication(
  userId: string,
  exchange: 'BINANCE' | 'BYBIT',
  uid: string,
): Promise<void> {
  const { error } = await supabase
    .from('applications')
    .insert({ user_id: userId, exchange, uid, status: 'PENDING' });
  if (error) {
    logger.error('applications insert 실패:', error.message);
    throw error;
  }
}
