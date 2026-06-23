import OpenAI from 'openai';
import { env } from './env';

/**
 * LLM 클라이언트 싱글톤.
 *
 * NOTE: 파일명/일부 export 이름에 'anthropic'·'CLAUDE'가 남아 있는 것은 레거시다
 * (과거 Anthropic Claude 사용). 실제 구현은 OpenAI(Chat Completions)로 교체됐다.
 * 호출부 회귀를 막기 위해 식별자는 유지하고 내부만 바꿨다.
 */
export const anthropic = new OpenAI({
  apiKey: env.openaiApiKey,
});

/**
 * 파이프라인 단계별 사용 모델 (값은 OpenAI 모델 ID).
 * - classify: 분류 / 내용중복 / 다국어 번역 (저비용)
 * - brief: 뉴스 브리프 / DART 번역 (고품질)
 */
export const CLAUDE_MODELS = {
  /** 뉴스 분류·중복·다국어 번역 (저비용) */
  classify: 'gpt-4o-mini',
  /** 뉴스 브리프 / DART 번역 (고품질) */
  brief: 'gpt-4o',
} as const;
