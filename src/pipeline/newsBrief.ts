import { CLAUDE_MODELS } from '../config/anthropic';
import { callClaudeJson } from './claudeJson';
import type { NewsBriefResult } from '../types';

const BRIEF_SYSTEM = `You are a financial news brief writer for K-Stock Helper.

Create a short English News Brief for foreign investors who follow Korean stocks.

Important:
- Translate the original title into natural English.
- Do not translate the article sentence by sentence.
- Do not reproduce the original wording or structure.
- Do not provide investment advice.
- Do not include buy/sell opinions.
- Do not predict stock price direction.
- Do not add facts not present in the input.

Return JSON only:
{
  "translated_title": "string",
  "summary": "string, max 300 characters",
  "key_points": [
    "string, max 150 characters",
    "string, max 150 characters",
    "string, max 150 characters"
  ]
}`;

/** 분류 통과 뉴스의 영문 브리프를 생성한다. */
export async function generateNewsBrief(input: {
  title: string;
  description: string;
}): Promise<NewsBriefResult> {
  const user = `Title: ${input.title}\n\nDescription/snippet: ${input.description}`;
  return callClaudeJson<NewsBriefResult>({
    model: CLAUDE_MODELS.brief,
    system: BRIEF_SYSTEM,
    user,
    maxTokens: 1024,
  });
}
