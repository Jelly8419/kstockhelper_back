import { anthropic } from '../config/anthropic';

/**
 * LLM 호출 1건의 과금 토큰 사용량. 비용 계측용.
 *
 * NOTE: 인터페이스명/필드명은 레거시(Claude)지만 값은 OpenAI usage에서 매핑된다.
 * OpenAI는 prompt caching이 자동(동일 prefix 1024토큰↑)이라 입력 토큰 중
 * 캐시 적중분이 prompt_tokens_details.cached_tokens로 보고된다 → cacheReadTokens로 매핑.
 * 캐시 쓰기(cacheCreationTokens)는 별도 과금/보고가 없어 항상 0.
 */
export interface ClaudeUsage {
  /** 풀가로 과금된 입력 토큰 (캐시 미적중분) */
  inputTokens: number;
  /** (레거시) OpenAI엔 캐시 쓰기 과금이 없어 항상 0 */
  cacheCreationTokens: number;
  /** 캐시 읽기 토큰 (OpenAI 자동 캐싱 적중분). 미적중이면 0 */
  cacheReadTokens: number;
  /** 출력 토큰 */
  outputTokens: number;
}

type CallParams = {
  model: string;
  system: string;
  user: string;
  maxTokens: number;
};

/** 공통 호출 로직 — 응답 텍스트와 usage를 함께 돌려준다. */
async function rawCall(params: CallParams): Promise<{ text: string; usage: ClaudeUsage }> {
  const res = await anthropic.chat.completions.create({
    model: params.model,
    max_tokens: params.maxTokens,
    // JSON 출력 강제. system/user 프롬프트에 'JSON' 단어가 포함돼야 동작한다
    // (모든 파이프라인 프롬프트가 "Return JSON only"를 포함하므로 충족).
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: params.system },
      { role: 'user', content: params.user },
    ],
  });

  const text = (res.choices[0]?.message?.content ?? '').trim();

  // OpenAI usage → 레거시 ClaudeUsage 매핑.
  // prompt_tokens는 캐시 적중분을 포함한 총 입력이므로, 캐시분을 빼서 inputTokens(풀가)와 분리한다.
  const cachedIn = res.usage?.prompt_tokens_details?.cached_tokens ?? 0;
  const promptTokens = res.usage?.prompt_tokens ?? 0;
  const usage: ClaudeUsage = {
    inputTokens: Math.max(0, promptTokens - cachedIn),
    cacheCreationTokens: 0, // OpenAI엔 캐시 쓰기 과금 없음
    cacheReadTokens: cachedIn,
    outputTokens: res.usage?.completion_tokens ?? 0,
  };

  return { text, usage };
}

/**
 * Claude를 호출하고 응답 텍스트에서 JSON 객체를 파싱한다.
 * 모델이 코드펜스(```json ... ```)나 앞뒤 설명을 붙여도 첫 { ... } 블록을 추출한다.
 *
 * @throws 호출 실패 또는 JSON 파싱 실패 시
 */
export async function callClaudeJson<T>(params: CallParams): Promise<T> {
  const { text } = await rawCall(params);
  return parseJsonBlock<T>(text);
}

/**
 * callClaudeJson과 동일하되, 과금 토큰 사용량(usage)을 함께 반환한다.
 * 비용 계측이 필요한 호출부(분류/dedup)에서 사용한다.
 *
 * @throws 호출 실패 또는 JSON 파싱 실패 시
 */
export async function callClaudeJsonWithUsage<T>(
  params: CallParams,
): Promise<{ result: T; usage: ClaudeUsage }> {
  const { text, usage } = await rawCall(params);
  return { result: parseJsonBlock<T>(text), usage };
}

/** 텍스트에서 첫 번째 균형 잡힌 { ... } 블록을 추출해 파싱 */
export function parseJsonBlock<T>(text: string): T {
  // 코드펜스 제거
  const cleaned = text.replace(/```json\s*/gi, '').replace(/```/g, '').trim();

  const start = cleaned.indexOf('{');
  if (start === -1) {
    throw new Error(`JSON 객체를 찾을 수 없음: ${text.slice(0, 120)}`);
  }

  let depth = 0;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const json = cleaned.slice(start, i + 1);
        return JSON.parse(json) as T;
      }
    }
  }
  throw new Error(`JSON 블록이 닫히지 않음: ${text.slice(0, 120)}`);
}
