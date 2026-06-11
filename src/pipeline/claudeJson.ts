import { anthropic } from '../config/anthropic';

/** Claude 호출 1건의 과금 토큰 사용량. 비용 계측용. */
export interface ClaudeUsage {
  /** 풀가로 과금된 입력 토큰 */
  inputTokens: number;
  /** 캐시 쓰기 토큰 (1.25x). 캐싱 작동 시에만 >0 */
  cacheCreationTokens: number;
  /** 캐시 읽기 토큰 (0.1x). 캐싱 적중 시에만 >0 */
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
  const res = await anthropic.messages.create({
    model: params.model,
    max_tokens: params.maxTokens,
    // 시스템 프롬프트는 매 호출 동일 → prompt caching으로 입력 비용 절감.
    // 캐시 TTL 5분. 같은 주기 내 연속 호출분이 캐시에 적중한다.
    system: [{ type: 'text', text: params.system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: params.user }],
  });

  const text = res.content
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('\n')
    .trim();

  const usage: ClaudeUsage = {
    inputTokens: res.usage.input_tokens,
    cacheCreationTokens: res.usage.cache_creation_input_tokens ?? 0,
    cacheReadTokens: res.usage.cache_read_input_tokens ?? 0,
    outputTokens: res.usage.output_tokens,
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
