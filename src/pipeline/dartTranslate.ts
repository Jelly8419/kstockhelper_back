import { CLAUDE_MODELS } from '../config/anthropic';
import { callClaudeJson } from './claudeJson';
import type { DartTranslateResult } from '../types';

const DART_SYSTEM = `You are a disclosure translation and summarization assistant for K-Stock Helper.

Your task:
- Translate the Korean disclosure title into natural English.
- Translate the disclosure content into English.
- Create a concise summary.
- Extract key figures if available.
- Create up to 3 key points.

Important:
- Do not provide investment advice.
- Do not include buy/sell opinions.
- Do not predict stock price direction.
- Preserve numbers, dates, company names, contract values, percentages accurately.

Return JSON only:
{
  "translated_title": "string",
  "english_translation": "string",
  "summary": "string",
  "key_figures": [{"label": "string", "value": "string"}],
  "key_points": ["string", "string", "string"]
}`;

/**
 * DART 공시를 번역/요약한다.
 * @param input.reportNm 공시 제목(원문)
 * @param input.content  공시 본문 텍스트 (document.xml에서 추출, 없으면 빈 문자열)
 */
export async function translateDisclosure(input: {
  reportNm: string;
  content: string;
}): Promise<DartTranslateResult> {
  const contentPart = input.content
    ? input.content
    : '(Full document text unavailable; use the title and metadata only.)';
  const user = `Disclosure title: ${input.reportNm}\n\nDisclosure content:\n${contentPart}`;

  return callClaudeJson<DartTranslateResult>({
    model: CLAUDE_MODELS.brief,
    system: DART_SYSTEM,
    user,
    maxTokens: 2048,
  });
}
