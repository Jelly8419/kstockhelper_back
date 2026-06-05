import Anthropic from '@anthropic-ai/sdk';
import { env } from './env';

/** Claude API 클라이언트 싱글톤. */
export const anthropic = new Anthropic({
  apiKey: env.anthropicApiKey,
});

/** 파이프라인 단계별 사용 모델 */
export const CLAUDE_MODELS = {
  /** 뉴스 분류 (저비용) */
  classify: 'claude-haiku-4-5-20251001',
  /** 뉴스 브리프 / DART 번역 (고품질) */
  brief: 'claude-sonnet-4-6',
} as const;
