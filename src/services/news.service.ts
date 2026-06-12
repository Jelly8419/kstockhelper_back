import { supabase } from '../config/supabase';
import { logger } from '../utils/logger';
import { buildSlug } from '../utils/slug';
import type { NewsInsert, NewsUpdate, RecentNewsRow } from '../types';

/**
 * 단건 뉴스를 insert 한다 (중복이면 무시).
 * @returns 신규 삽입 시 그 행의 id, 이미 존재(중복)면 null
 */
export async function insertNewsIfNew(item: NewsInsert): Promise<string | null> {
  const { data, error } = await supabase
    .from('news')
    .upsert([item], { onConflict: 'source,external_id', ignoreDuplicates: true })
    .select('id');

  if (error) {
    logger.error('news 단건 저장 실패:', error.message);
    throw error;
  }
  return data && data.length > 0 ? String(data[0].id) : null;
}

/**
 * news_stocks 조인 테이블에 (news_id, stock_id) 연결을 추가한다.
 * 이미 있으면 무시 (PK 또는 unique 충돌 ignore).
 */
export async function linkNewsStocks(newsId: string, stockIds: string[]): Promise<void> {
  if (stockIds.length === 0) return;
  const rows = stockIds.map((stockId) => ({ news_id: newsId, stock_id: stockId }));

  const { error } = await supabase
    .from('news_stocks')
    .upsert(rows, { onConflict: 'news_id,stock_id', ignoreDuplicates: true });

  if (error) {
    logger.error('news_stocks 연결 실패:', error.message);
    throw error;
  }
}

/** 파이프라인 결과로 news 행을 갱신한다 (source + external_id 기준). */
export async function updateNews(
  source: string,
  externalId: string,
  patch: NewsUpdate,
): Promise<void> {
  // 영문 제목(translated_title)이 갱신되면 SEO URL용 slug도 함께 파생해 저장한다.
  // publish 시점에 translated_title이 채워지므로 slug도 그때 한 번 확정되어 고정된다.
  // (호출 측에서 slug를 명시했다면 그 값을 존중한다.)
  const finalPatch: NewsUpdate =
    patch.translated_title !== undefined && patch.slug === undefined
      ? { ...patch, slug: buildSlug(patch.translated_title) }
      : patch;

  const { error } = await supabase
    .from('news')
    .update(finalPatch)
    .eq('source', source)
    .eq('external_id', externalId);

  if (error) {
    logger.error('news 갱신 실패:', error.message);
    throw error;
  }
}

/**
 * 중복 비교용: 최근 N시간 내 수집된 뉴스 행을 조회한다.
 * canonical_url / title / body / related_stocks 만 가져온다.
 */
export async function getRecentNews(hours: number): Promise<RecentNewsRow[]> {
  const sinceIso = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('news')
    .select('external_id, canonical_url, title, body, related_stocks')
    .gte('created_at', sinceIso);

  if (error) {
    logger.error('최근 뉴스 조회 실패:', error.message);
    throw error;
  }
  return (data ?? []) as RecentNewsRow[];
}
