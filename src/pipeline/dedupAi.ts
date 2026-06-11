import { CLAUDE_MODELS } from '../config/anthropic';
import { callClaudeJsonWithUsage, type ClaudeUsage } from './claudeJson';
import { similarity } from '../utils/similarity';
import type { RecentNewsRow } from '../types';

/**
 * 2차(내용 기반) 중복 판단.
 *
 * 1차 문자열 dedup(pipeline/dedup.ts)을 통과한 기사 중,
 * "같은 종목 + 문자열 유사도 애매구간" 후보에 대해서만 Claude(haiku)를 호출해
 * 의미 기반 중복 여부를 판정한다. 명백한 중복/명백한 신규는 문자열 점수로 가르고
 * AI를 호출하지 않아 비용을 최소화한다.
 */

/**
 * 이 구간만 AI 호출 — 위(≥0.85)는 1차 dedup에서 이미 중복 처리됨.
 * 하한 0.25: 같은 사건이라도 표현이 많이 다르면(예: "압수수색했다" vs "추가 압수수색을 실시했다")
 * 문자 유사도가 0.25~0.48까지 떨어진다. 기존 0.5 하한에서는 이 구간이 통째로 새어
 * 같은 사건 기사가 중복 게시됐다. 하한을 낮춰 AI가 의미 기반으로 판정하게 한다.
 * (무관 기사 폭증은 같은 종목 한정 + MAX_COMPARE_PAIRS 상한으로 억제)
 */
const AI_SIM_LOWER = 0.25;
const AI_SIM_UPPER = 0.85;
/** 후보당 AI에 넘길 비교 대상 최대 건수 (토큰/비용 상한). 하한을 낮춘 만큼 약간 늘림 */
const MAX_COMPARE_PAIRS = 8;

const DEDUP_SYSTEM = `You are a news deduplication judge for K-Stock Helper.

You are given ONE new article and ONE existing article about the same Korean stock(s).
Decide whether the new article is a DUPLICATE of the existing one.

Treat as DUPLICATE when ALL of the following hold:
- Same core event (even if titles or wording differ).
- Same subject company.
- Same time frame.
- The new article adds little or no new information (only rephrasing or a different headline).

Treat as NOT a duplicate (it is new) when ANY of the following hold:
- Different event type for the same company.
- A materially new figure is added or changed (e.g. market share %, earnings guidance, contract amount).
- A new fact that could affect investment judgment.
- A follow-up disclosure, earnings release, contract signing, or regulatory event.

Example of the SAME core event (these would be duplicates of each other):
- "Samsung Electronics keeps No.1 in DRAM market"
- "Samsung Electronics leads with 38.6% DRAM share"
- "Samsung widens gap over SK Hynix"
BUT if the share figure itself changed between reports, treat the newer one as NOT a duplicate (material update).

Return JSON only:
{
  "duplicate": true | false,
  "reason": "Short reason within 120 characters"
}`;

export interface AiDedupResult {
  isDuplicate: boolean;
  reason?: string;
  matchedExternalId?: string;
  /** 이번 dedup 판정에서 발생한 실제 Claude 호출 수 (비용 계측용) */
  aiCalls: number;
  /** 이번 dedup 판정의 총 입력 토큰(풀가+캐시쓰기+캐시읽기 합산) */
  inputTokens: number;
  /** 이번 dedup 판정의 총 출력 토큰 */
  outputTokens: number;
}

/** ClaudeUsage를 누적기에 더한다. */
function addUsage(
  acc: { calls: number; input: number; output: number },
  u: ClaudeUsage,
): void {
  acc.calls += 1;
  acc.input += u.inputTokens + u.cacheCreationTokens + u.cacheReadTokens;
  acc.output += u.outputTokens;
}

interface AiDedupVerdict {
  duplicate: boolean;
  reason: string;
}

/** 두 종목 집합이 하나라도 겹치는지 */
function stocksOverlap(a: string[], b: string[] | null): boolean {
  if (!b || b.length === 0) return false; // 종목 확정 후 호출되므로, 겹치지 않으면 비교 안 함
  const setB = new Set(b);
  return a.some((s) => setB.has(s));
}

interface AiDedupCandidate {
  title: string;
  body: string;
  /** classify로 확정된 관련 종목 영문명 */
  relatedStocks: string[];
}

/**
 * 후보 기사가 같은 종목의 최근 뉴스와 "내용상" 중복인지 AI로 판정한다.
 * 1차 문자열 dedup을 통과한 기사에만 호출할 것.
 *
 * @returns 중복이면 isDuplicate=true. AI 호출 0건이면(애매 후보 없음) 즉시 false.
 */
export async function checkDuplicateAi(
  candidate: AiDedupCandidate,
  recent: RecentNewsRow[],
): Promise<AiDedupResult> {
  // 같은 종목 + 유사도 애매구간 후보만 추린다.
  const pairs: Array<{ row: RecentNewsRow; sim: number }> = [];
  for (const row of recent) {
    if (!stocksOverlap(candidate.relatedStocks, row.related_stocks)) continue;
    if (!row.body) continue;

    const sim = similarity(candidate.body, row.body);
    if (sim >= AI_SIM_LOWER && sim < AI_SIM_UPPER) {
      pairs.push({ row, sim });
    }
  }

  // 호출별 토큰 누적기 (비용 계측)
  const acc = { calls: 0, input: 0, output: 0 };

  if (pairs.length === 0) {
    // AI 호출 없음 — 비용 0
    return { isDuplicate: false, aiCalls: 0, inputTokens: 0, outputTokens: 0 };
  }

  // 유사도 높은 순으로 상한까지만 AI 비교 (가장 중복 가능성 높은 것부터)
  pairs.sort((a, b) => b.sim - a.sim);
  const targets = pairs.slice(0, MAX_COMPARE_PAIRS);

  for (const { row } of targets) {
    const user =
      `New article:\nTitle: ${candidate.title}\nBody: ${candidate.body}\n\n` +
      `Existing article:\nTitle: ${row.title}\nBody: ${row.body}`;

    const { result: verdict, usage } = await callClaudeJsonWithUsage<AiDedupVerdict>({
      model: CLAUDE_MODELS.classify, // haiku
      system: DEDUP_SYSTEM,
      user,
      maxTokens: 256,
    });
    addUsage(acc, usage);

    if (verdict.duplicate) {
      return {
        isDuplicate: true,
        reason: `AI 내용 중복: ${verdict.reason}`,
        matchedExternalId: row.external_id,
        aiCalls: acc.calls,
        inputTokens: acc.input,
        outputTokens: acc.output,
      };
    }
  }

  return { isDuplicate: false, aiCalls: acc.calls, inputTokens: acc.input, outputTokens: acc.output };
}
