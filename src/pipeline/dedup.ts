import { similarity } from '../utils/similarity';
import type { RecentNewsRow } from '../types';

const TITLE_SIM_THRESHOLD = 0.85;
const SNIPPET_SIM_THRESHOLD = 0.8;

export interface DedupCandidate {
  canonicalUrl: string;
  normalizedTitle: string;
  snippet: string;
  /** 관련 종목 영문명 (겹침 판정용) */
  relatedStocks: string[];
}

export interface DedupResult {
  isDuplicate: boolean;
  reason?: string;
  matchedExternalId?: string;
}

/** 두 종목 집합이 하나라도 겹치는지 */
function stocksOverlap(a: string[], b: string[] | null): boolean {
  if (!b || b.length === 0) return true; // 후보의 종목 정보가 없으면 비교 대상에 포함(보수적)
  const setB = new Set(b);
  return a.some((s) => setB.has(s));
}

/**
 * 후보 뉴스가 최근 N시간(호출 측 DEDUP_WINDOW_HOURS) 내 관련 종목이 겹치는 기존 뉴스와 중복인지 판정한다.
 * 판정 기준:
 *   - canonical_url 동일, 또는
 *   - 제목 유사도 ≥ 85%, 또는
 *   - snippet 유사도 ≥ 80%
 */
export function checkDuplicate(
  candidate: DedupCandidate,
  recent: RecentNewsRow[],
): DedupResult {
  for (const row of recent) {
    // 관련 종목이 겹치는 뉴스만 비교 대상
    if (!stocksOverlap(candidate.relatedStocks, row.related_stocks)) continue;

    if (row.canonical_url && row.canonical_url === candidate.canonicalUrl) {
      return { isDuplicate: true, reason: 'canonical_url 동일', matchedExternalId: row.external_id };
    }

    const titleSim = similarity(candidate.normalizedTitle, row.title);
    if (titleSim >= TITLE_SIM_THRESHOLD) {
      return {
        isDuplicate: true,
        reason: `제목 유사도 ${(titleSim * 100).toFixed(0)}%`,
        matchedExternalId: row.external_id,
      };
    }

    if (candidate.snippet && row.body) {
      const snippetSim = similarity(candidate.snippet, row.body);
      if (snippetSim >= SNIPPET_SIM_THRESHOLD) {
        return {
          isDuplicate: true,
          reason: `snippet 유사도 ${(snippetSim * 100).toFixed(0)}%`,
          matchedExternalId: row.external_id,
        };
      }
    }
  }

  return { isDuplicate: false };
}
