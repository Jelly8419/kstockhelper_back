import { supabase } from '../config/supabase';
import { logger } from '../utils/logger';
import { translateContent } from '../pipeline/translateContent';
import { logProcessing } from './processingLog.service';
import {
  CONTENT_LOCALES,
  isContentLocale,
  type ContentLocale,
  type TranslateContentResult,
} from '../types';

/**
 * 뉴스 콘텐츠 번역 서비스.
 *
 * - 선제 번역(pretranslateNews): 게시 직후 5개 언어를 미리 번역해 저장 → 목록도 번역어 노출.
 * - lazy 조회(getOrCreateTranslation): 캐시 없으면 즉석 번역(선제 번역 누락분 보강용).
 *
 * 둘 다 news 영문 가공본(translated_title/summary/key_points)만 Haiku로 번역한다.
 */

/** getOrCreateTranslation 결과. fallback이면 영문 그대로(translation=null). */
export interface TranslationResult {
  /** 'cache' = 캐시 적중, 'created' = 새로 번역, 'fallback_en' = 영문 fallback, 'not_found' = 기사 없음 */
  outcome: 'cache' | 'created' | 'fallback_en' | 'not_found';
  locale: string;
  translation: TranslateContentResult | null;
}

/** news 본체의 영문 콘텐츠 필드 */
interface NewsEnglishContent {
  translated_title: string | null;
  summary: string | null;
  key_points: string[] | null;
}

/** news_translations 캐시 조회 */
async function findCached(
  newsId: string,
  locale: ContentLocale,
): Promise<TranslateContentResult | null> {
  const { data, error } = await supabase
    .from('news_translations')
    .select('translated_title, summary, key_points')
    .eq('news_id', newsId)
    .eq('locale', locale)
    .maybeSingle();

  if (error) {
    logger.warn(`번역 캐시 조회 실패 (news=${newsId}, locale=${locale}):`, error.message);
    return null; // 조회 실패 시 캐시 미스로 폴백 (새로 번역 — 안전)
  }
  if (!data) return null;
  return {
    translated_title: data.translated_title ?? '',
    summary: data.summary ?? '',
    key_points: (data.key_points as string[] | null) ?? [],
  };
}

/** news 본체의 영문 콘텐츠 로드 */
async function loadEnglish(newsId: string): Promise<NewsEnglishContent | null> {
  const { data, error } = await supabase
    .from('news')
    .select('translated_title, summary, key_points')
    .eq('id', newsId)
    .maybeSingle();

  if (error) {
    logger.error(`news 영문 콘텐츠 조회 실패 (id=${newsId}):`, error.message);
    throw error;
  }
  if (!data) return null;
  return {
    translated_title: data.translated_title as string | null,
    summary: data.summary as string | null,
    key_points: data.key_points as string[] | null,
  };
}

/**
 * 영문 콘텐츠를 1개 locale로 번역해 news_translations에 저장하고 결과를 반환한다.
 * 번역/저장/비용계측을 한 곳에 모아 lazy·선제 양쪽이 공유한다.
 */
async function translateAndStore(
  newsId: string,
  locale: ContentLocale,
  english: NewsEnglishContent,
): Promise<TranslateContentResult> {
  const { result, usage } = await translateContent(
    {
      translated_title: english.translated_title ?? '',
      summary: english.summary ?? '',
      key_points: english.key_points ?? [],
    },
    locale,
  );

  // 캐시 저장 (동시 요청/재실행 충돌 시 onConflict로 무시 → 재실행 안전)
  const { error: upsertErr } = await supabase.from('news_translations').upsert(
    [
      {
        news_id: newsId,
        locale,
        translated_title: result.translated_title,
        summary: result.summary,
        key_points: result.key_points,
      },
    ],
    { onConflict: 'news_id,locale', ignoreDuplicates: true },
  );
  if (upsertErr) {
    // 저장 실패해도 번역 결과는 반환 (다음 기회에 재시도)
    logger.warn(`번역 캐시 저장 실패 (news=${newsId}, locale=${locale}):`, upsertErr.message);
  }

  // 비용 계측 — 번역 토큰을 cost_metric 로그로 기록 (haiku)
  const inTok = usage.inputTokens + usage.cacheCreationTokens + usage.cacheReadTokens;
  await logProcessing({
    source: 'TRANSLATE',
    external_id: `${newsId}:${locale}`,
    stage: 'cost_metric',
    status: 'translate',
    reason: `haiku in ${inTok}/out ${usage.outputTokens}`,
    meta: { newsId, locale, inputTokens: inTok, outputTokens: usage.outputTokens },
  });

  return result;
}

/**
 * 게시된 뉴스 1건을 5개 콘텐츠 언어로 선제 번역해 저장한다.
 * 게시 직후 호출 → 목록/상세 모두 첫 노출부터 번역어로 보인다.
 *
 * - 이미 번역된 locale은 건너뛴다 (재실행/재게시 안전).
 * - 영문 콘텐츠가 비어있으면 아무것도 안 함.
 * - 한 언어 실패가 나머지를 막지 않는다 (개별 try/catch).
 *
 * @returns 이번 호출에서 새로 생성한 locale 수
 */
export async function pretranslateNews(newsId: string): Promise<number> {
  const english = await loadEnglish(newsId);
  if (!english) return 0;
  if (!english.translated_title && !english.summary) return 0;

  // 이미 존재하는 locale 집합 (중복 번역 방지)
  const { data: existing, error: exErr } = await supabase
    .from('news_translations')
    .select('locale')
    .eq('news_id', newsId);
  if (exErr) {
    logger.warn(`기존 번역 조회 실패 (news=${newsId}):`, exErr.message);
    // 조회 실패해도 진행 — upsert ignoreDuplicates가 중복을 막아줌
  }
  const done = new Set((existing ?? []).map((r) => String(r.locale)));

  let created = 0;
  for (const locale of CONTENT_LOCALES) {
    if (done.has(locale)) continue;
    try {
      await translateAndStore(newsId, locale, english);
      created++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`선제 번역 실패 (news=${newsId}, locale=${locale}):`, msg);
      // 실패한 locale은 lazy 조회 때 다시 시도됨
    }
  }
  if (created > 0) {
    logger.info(`선제 번역 완료 — news=${newsId}, 신규 ${created}개 언어`);
  }
  return created;
}

/**
 * 뉴스 콘텐츠 번역을 조회하거나(캐시) 생성한다(없으면 Haiku 번역 후 저장).
 * 선제 번역이 누락/실패한 (기사, 언어)를 조회 시점에 보강한다.
 *
 * @param newsId news.id
 * @param locale 요청 locale (en/화이트리스트 밖이면 영문 fallback)
 */
export async function getOrCreateTranslation(
  newsId: string,
  locale: string,
): Promise<TranslationResult> {
  // 1) 화이트리스트 밖(en 포함) → 영문 fallback (번역/저장 안 함)
  if (!isContentLocale(locale)) {
    return { outcome: 'fallback_en', locale, translation: null };
  }

  // 2) 캐시 조회
  const cached = await findCached(newsId, locale);
  if (cached) {
    return { outcome: 'cache', locale, translation: cached };
  }

  // 3) news 영문 콘텐츠 로드
  const english = await loadEnglish(newsId);
  if (!english) {
    return { outcome: 'not_found', locale, translation: null };
  }
  // 번역할 영문 콘텐츠가 비어있으면 fallback (게시 전 기사 등)
  if (!english.translated_title && !english.summary) {
    return { outcome: 'fallback_en', locale, translation: null };
  }

  // 4) Haiku 번역 + 저장 + 계측 (공통 헬퍼)
  const result = await translateAndStore(newsId, locale, english);
  return { outcome: 'created', locale, translation: result };
}
