import { supabase } from '../config/supabase';
import { logger } from '../utils/logger';
import type { ProcessingLogInsert } from '../types';

/**
 * 최근 N시간 내 classification 단계를 이미 거친 external_id 집합을 반환한다.
 * 분류 결과 캐싱용: 같은 기사를 매 주기 다시 Claude(haiku)로 재분류하는 낭비를 막는다.
 * 조회 실패 시 빈 집합 반환 → 캐시 미스로 폴백(분류는 수행되되 비용만 발생, 동작은 안전).
 */
export async function getRecentlyClassifiedIds(
  source: string,
  hours: number,
): Promise<Set<string>> {
  const sinceIso = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('processing_logs')
    .select('external_id')
    .eq('source', source)
    .eq('stage', 'classification')
    .gte('created_at', sinceIso);

  if (error) {
    logger.warn('최근 분류 이력 조회 실패(분류 캐시 미적용):', error.message);
    return new Set<string>();
  }
  return new Set((data ?? []).map((r) => String(r.external_id)));
}

/**
 * 파이프라인 처리 결과를 processing_logs 테이블에 기록 + 콘솔 출력.
 * 로그 적재 실패가 메인 파이프라인을 막지 않도록 예외를 삼킨다.
 */
export async function logProcessing(entry: ProcessingLogInsert): Promise<void> {
  const { source, external_id, stage, status, reason } = entry;

  // 콘솔: 한 줄 요약
  logger.info(
    `[PIPELINE] ${status} (${source}/${stage})` +
      (reason ? ` — ${reason}` : '') +
      ` :: ${external_id}`,
  );

  try {
    const { error } = await supabase.from('processing_logs').insert({
      source,
      external_id,
      stage,
      status,
      reason: reason ?? null,
      meta: entry.meta ?? null,
    });
    if (error) {
      logger.warn('processing_logs 적재 실패:', error.message);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('processing_logs 적재 예외:', msg);
  }
}
