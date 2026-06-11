import { Router } from 'express';
import { getOrCreateTranslation } from '../services/translation.service';
import { logger } from '../utils/logger';

export const newsRouter = Router();

/**
 * POST /api/news/:id/translate?locale=vi
 *
 * 뉴스 콘텐츠(제목/요약/핵심)를 요청 locale로 번역해 반환한다 (lazy 캐싱).
 * - 캐시 있으면 즉시 반환, 없으면 Haiku 번역 후 저장하고 반환.
 * - en / 화이트리스트(vi,ru,pt-BR,hi,uk) 밖 locale → 영문 fallback 신호 반환
 *   (data=null, 프론트는 news 본체의 영문 필드를 그대로 사용).
 *
 * 응답:
 *   200 { success:true, code, data: { locale, translated_title, summary, key_points } | null }
 *   404 { success:false, code:'NEWS_NOT_FOUND' }
 *   400 { success:false, code:'NEWS_ID_REQUIRED' }
 *   500 { success:false, code:'TRANSLATION_ERROR' }
 */
newsRouter.post('/:id/translate', async (req, res) => {
  const newsId = req.params.id;
  const locale = String(req.query.locale ?? '').trim();

  if (!newsId) {
    return res.status(400).json({
      success: false,
      code: 'NEWS_ID_REQUIRED',
      message: 'news id is required.',
    });
  }

  try {
    const r = await getOrCreateTranslation(newsId, locale);

    if (r.outcome === 'not_found') {
      return res.status(404).json({
        success: false,
        code: 'NEWS_NOT_FOUND',
        message: 'The specified news was not found.',
      });
    }

    // 영문 fallback (en 또는 화이트리스트 밖, 또는 번역할 영문이 비어있음)
    if (r.outcome === 'fallback_en') {
      return res.status(200).json({
        success: true,
        code: 'TRANSLATION_FALLBACK_EN',
        message: 'Content is served in English for this locale.',
        data: null,
      });
    }

    // cache | created
    return res.status(200).json({
      success: true,
      code: r.outcome === 'cache' ? 'TRANSLATION_CACHE_HIT' : 'TRANSLATION_CREATED',
      data: {
        locale: r.locale,
        translated_title: r.translation?.translated_title ?? '',
        summary: r.translation?.summary ?? '',
        key_points: r.translation?.key_points ?? [],
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`뉴스 번역 처리 실패 (news=${newsId}, locale=${locale}):`, msg);
    return res.status(500).json({
      success: false,
      code: 'TRANSLATION_ERROR',
      message: 'An error occurred while translating the content.',
    });
  }
});
