import { anthropic } from '../config/anthropic';

/**
 * Claude를 호출하고 응답 텍스트에서 JSON 객체를 파싱한다.
 * 모델이 코드펜스(```json ... ```)나 앞뒤 설명을 붙여도 첫 { ... } 블록을 추출한다.
 *
 * @throws 호출 실패 또는 JSON 파싱 실패 시
 */
export async function callClaudeJson<T>(params: {
  model: string;
  system: string;
  user: string;
  maxTokens: number;
}): Promise<T> {
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

  return parseJsonBlock<T>(text);
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
