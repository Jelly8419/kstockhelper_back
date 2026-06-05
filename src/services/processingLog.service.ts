import { supabase } from '../config/supabase';
import { logger } from '../utils/logger';
import type { ProcessingLogInsert } from '../types';

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
