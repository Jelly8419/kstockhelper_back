/**
 * Feature Flags — 기능 노출 토글 조회/변경 (service_role).
 *
 * key-value 테이블(feature_flags)을 FeatureFlags 객체로 매핑한다.
 * 안전 원칙: DB 조회 실패/키 없음이면 false(미노출)로 폴백한다 —
 * 백엔드 장애가 의도치 않은 기능 노출로 이어지지 않게 한다.
 */
import { supabase } from '../config/supabase';
import { logger } from '../utils/logger';
import type { FeatureFlags } from '../types';

/** 알려진 flag 키와 기본값 (키가 DB에 없을 때 사용). 향후 키 추가 시 여기에. */
const FLAG_DEFAULTS: FeatureFlags = {
  priceGapPublic: false,
};

const FLAG_KEYS = Object.keys(FLAG_DEFAULTS) as (keyof FeatureFlags)[];

interface FlagRow {
  key: string;
  enabled: boolean;
}

/**
 * 전체 flag 상태를 FeatureFlags로 반환. DB 행을 기본값 위에 덮어쓴다.
 * 조회 실패 시 전부 기본값(false)으로 안전 폴백.
 */
export async function getAllFlags(): Promise<FeatureFlags> {
  const flags: FeatureFlags = { ...FLAG_DEFAULTS };
  try {
    const { data, error } = await supabase.from('feature_flags').select('key, enabled');
    if (error) throw error;
    for (const row of (data ?? []) as FlagRow[]) {
      if ((FLAG_KEYS as string[]).includes(row.key)) {
        flags[row.key as keyof FeatureFlags] = row.enabled;
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('feature_flags 조회 실패 — 기본값(false) 폴백:', msg);
  }
  return flags;
}

/**
 * flag 값 변경(upsert). updated_at은 트리거가 갱신.
 * @returns 변경 후 전체 flag 상태
 */
export async function setFlag(
  key: keyof FeatureFlags,
  enabled: boolean,
  updatedBy: string | null,
): Promise<FeatureFlags> {
  const { error } = await supabase
    .from('feature_flags')
    .upsert({ key, enabled, updated_by: updatedBy }, { onConflict: 'key' });

  if (error) {
    logger.error(`feature_flags 변경 실패 (key=${key}):`, error.message);
    throw error;
  }
  logger.info(`feature flag 변경 — ${key}=${enabled} (by ${updatedBy ?? 'unknown'})`);
  return getAllFlags();
}

/** 요청 body가 알려진 flag 키인지 검증 (관리자 PATCH용) */
export function isKnownFlagKey(key: unknown): key is keyof FeatureFlags {
  return typeof key === 'string' && (FLAG_KEYS as string[]).includes(key);
}

export { FLAG_KEYS };
