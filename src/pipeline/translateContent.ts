import { CLAUDE_MODELS } from '../config/anthropic';
import { callClaudeJsonWithUsage, type ClaudeUsage } from './claudeJson';
import type { ContentLocale, TranslateContentResult } from '../types';

/**
 * 이미 영문으로 가공된 뉴스 콘텐츠(제목/요약/핵심)를 대상 언어로 번역한다.
 *
 * 원문(한국어)에서 다국어를 직접 생성하지 않고, 짧은 영문 가공본만 번역해
 * 입력 토큰을 최소화한다(PRD: 비용 절감). 단순 번역 작업이라 haiku를 사용한다.
 * 제목·요약·핵심을 한 번의 호출로 묶어 JSON으로 받아 원자적으로 처리한다.
 */

/** locale → 번역 지시문에 쓸 언어명 (모델이 명확히 이해하도록 영문 표기) */
const LOCALE_LANGUAGE: Record<ContentLocale, string> = {
  vi: 'Vietnamese',
  ru: 'Russian',
  'pt-BR': 'Brazilian Portuguese',
  hi: 'Hindi',
  uk: 'Ukrainian',
};

function buildSystem(language: string): string {
  return `Translate the following English financial news fields into ${language}.

Rules:
- Translate naturally and fluently for native ${language} readers.
- Keep it a translation — do not summarize, expand, add, or omit information.
- Keep company names, tickers, and numbers as-is (do not localize figures or currencies).
- Do not provide investment advice or opinions.
- key_points is an array; translate each item, keep the same order and count.

Return JSON only:
{"translated_title":"string","summary":"string","key_points":["string", ...]}`;
}

/**
 * 영문 콘텐츠를 대상 locale로 번역한다.
 * @returns 번역 결과 + 토큰 사용량(usage). usage는 비용 계측에 사용한다.
 */
export async function translateContent(
  input: { translated_title: string; summary: string; key_points: string[] },
  locale: ContentLocale,
): Promise<{ result: TranslateContentResult; usage: ClaudeUsage }> {
  const language = LOCALE_LANGUAGE[locale];

  const user =
    `Title: ${input.translated_title}\n\n` +
    `Summary: ${input.summary}\n\n` +
    `Key points (JSON array): ${JSON.stringify(input.key_points)}`;

  return callClaudeJsonWithUsage<TranslateContentResult>({
    model: CLAUDE_MODELS.classify, // haiku
    system: buildSystem(language),
    user,
    // 2048: 데바나가리(hi) 등 비라틴 문자는 같은 내용도 토큰을 많이 써서
    // 긴 summary 번역 시 1024로는 응답이 잘려(JSON 미완성) 실패한다. 여유 확보.
    // 출력은 실제 생성량만큼만 과금되므로 상한을 올려도 비용 영향 없음.
    maxTokens: 2048,
  });
}
