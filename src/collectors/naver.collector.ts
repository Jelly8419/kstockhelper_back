import axios from 'axios';
import { env } from '../config/env';
import { STOCKS, STOCK_ID_BY_NAME_EN } from '../constants/stocks';
import { logger } from '../utils/logger';
import { normalizeUrl } from '../utils/urlNormalize';
import { normalizeTitle } from '../utils/titleNormalize';
import {
  getRecentNews,
  insertNewsIfNew,
  updateNews,
  linkNewsStocks,
} from '../services/news.service';
import { logProcessing, getRecentlyClassifiedIds } from '../services/processingLog.service';
import { checkDuplicate } from '../pipeline/dedup';
import { checkDuplicateAi } from '../pipeline/dedupAi';
import { classifyNews, shouldPublish } from '../pipeline/classify';
import { generateNewsBrief } from '../pipeline/newsBrief';
import { pretranslateNews } from '../services/translation.service';
import type { NaverNewsResponse, NaverNewsItem } from '../types';

const NAVER_NEWS_URL = 'https://openapi.naver.com/v1/search/news.json';
const DEDUP_WINDOW_HOURS = 48;
const DISPLAY_PER_KEYWORD = 15;
const SOURCE = 'NAVER';

/** 검색 키워드 = 종목 한글명 */
const KEYWORDS = STOCKS.map((s) => s.name);

interface PreparedItem {
  externalId: string; // canonical_url
  canonicalUrl: string;
  normalizedTitle: string;
  description: string; // 태그 제거된 snippet
  link: string;
  pubDate: string;
}

/** RFC1123(pubDate) → ISO. 실패 시 현재시각 (published_at NOT NULL 대응) */
function toIso(pubDate: string): string {
  const t = Date.parse(pubDate);
  return Number.isNaN(t) ? new Date().toISOString() : new Date(t).toISOString();
}

/** description의 HTML 태그/엔티티 제거 */
function cleanDescription(s: string): string {
  return normalizeTitle(s); // 동일 규칙(태그/엔티티 제거)으로 충분
}

/** 단일 키워드 뉴스 검색 */
async function searchNews(keyword: string): Promise<NaverNewsItem[]> {
  const { data } = await axios.get<NaverNewsResponse>(NAVER_NEWS_URL, {
    params: { query: keyword, display: DISPLAY_PER_KEYWORD, sort: 'date' },
    headers: {
      'X-Naver-Client-Id': env.naverClientId,
      'X-Naver-Client-Secret': env.naverClientSecret,
    },
    timeout: 10_000,
  });
  return data.items ?? [];
}

/** 네이버 항목 → 정규화된 내부 표현 */
function prepare(item: NaverNewsItem): PreparedItem {
  const link = item.originallink || item.link;
  const canonicalUrl = normalizeUrl(link);
  return {
    externalId: canonicalUrl,
    canonicalUrl,
    normalizedTitle: normalizeTitle(item.title),
    description: cleanDescription(item.description),
    link,
    pubDate: toIso(item.pubDate),
  };
}

/**
 * 네이버 뉴스 수집 + Claude 분류/브리프 파이프라인.
 * 흐름: 검색 → 정규화 → (DB+배치내) 중복제거 → classification(상한) → brief → 게시
 */
export async function collectNaverNews(): Promise<void> {
  // 1) 전 키워드 검색 + 정규화
  const prepared: PreparedItem[] = [];
  for (const keyword of KEYWORDS) {
    try {
      const items = await searchNews(keyword);
      prepared.push(...items.map(prepare));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`NAVER 검색 실패 [${keyword}]:`, msg);
    }
  }
  if (prepared.length === 0) {
    logger.info('NAVER 수집 — 검색 결과 없음');
    return;
  }

  // 2) 최근 N시간 후보군 조회 (중복 비교 기준, DEDUP_WINDOW_HOURS)
  const recent = await getRecentNews(DEDUP_WINDOW_HOURS);

  // 2-1) 분류 결과 캐시: 최근 N시간 내 이미 classify한 external_id.
  // classify에서 skip된 기사는 news에 저장되지 않아 dedup에 안 걸리고 매 주기 재분류된다.
  // 이 집합으로 그 재분류(haiku 재호출)를 막는다.
  const classifiedIds = await getRecentlyClassifiedIds(SOURCE, DEDUP_WINDOW_HOURS);

  // 배치 내 중복도 거르기 위한 진행 중 canonical 집합
  const seenInBatch = new Set<string>();
  let classifyBudget = env.maxClassifyPerRun;
  let publishedCount = 0;
  let cacheSkippedCount = 0;

  // ── 비용 계측 누적기 (이번 주기 haiku 토큰 사용량) ──
  let classifyCalls = 0;
  let classifyInTok = 0;
  let classifyOutTok = 0;
  let dedupCalls = 0;
  let dedupInTok = 0;
  let dedupOutTok = 0;

  for (const p of prepared) {
    // 배치 내 동일 URL 중복
    if (seenInBatch.has(p.canonicalUrl)) {
      await logProcessing({
        source: SOURCE,
        external_id: p.externalId,
        stage: 'dedup',
        status: 'duplicate',
        reason: '배치 내 canonical_url 중복',
      });
      continue;
    }
    seenInBatch.add(p.canonicalUrl);

    // 3) DB 후보군과 중복 판정 (종목 정보는 아직 모르므로 전체 후보 비교)
    const dup = checkDuplicate(
      {
        canonicalUrl: p.canonicalUrl,
        normalizedTitle: p.normalizedTitle,
        snippet: p.description,
        relatedStocks: [], // 분류 전이라 비움 → dedup은 모든 후보와 비교(보수적)
      },
      recent,
    );
    if (dup.isDuplicate) {
      await logProcessing({
        source: SOURCE,
        external_id: p.externalId,
        stage: 'dedup',
        status: 'duplicate',
        reason: dup.reason,
      });
      continue;
    }

    // 3-1) 분류 캐시 적중 → 최근 이미 classify한 기사. haiku 재호출 스킵 (비용 절감 핵심).
    if (classifiedIds.has(p.canonicalUrl)) {
      cacheSkippedCount++;
      continue;
    }

    // 4) classification 호출 상한
    if (classifyBudget <= 0) {
      await logProcessing({
        source: SOURCE,
        external_id: p.externalId,
        stage: 'classification',
        status: 'skipped',
        reason: `주기당 상한(${env.maxClassifyPerRun}) 초과 — 다음 주기 처리`,
      });
      continue;
    }
    classifyBudget--;

    // 5) Claude classification (haiku)
    let classification;
    try {
      const classifyRes = await classifyNews({
        title: p.normalizedTitle,
        description: p.description,
      });
      classification = classifyRes.result;
      classifyCalls += 1;
      classifyInTok +=
        classifyRes.usage.inputTokens +
        classifyRes.usage.cacheCreationTokens +
        classifyRes.usage.cacheReadTokens;
      classifyOutTok += classifyRes.usage.outputTokens;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await logProcessing({
        source: SOURCE,
        external_id: p.externalId,
        stage: 'classification',
        status: 'gpt_classification_failed',
        reason: msg,
      });
      continue;
    }

    if (!shouldPublish(classification)) {
      await logProcessing({
        source: SOURCE,
        external_id: p.externalId,
        stage: 'classification',
        status: 'classification_skip',
        reason: `${classification.decision}/conf${classification.confidence}: ${classification.reason}`,
      });
      continue;
    }

    await logProcessing({
      source: SOURCE,
      external_id: p.externalId,
      stage: 'classification',
      status: 'classification_publish',
      reason: `${classification.category} conf${classification.confidence}`,
    });

    // 5-1) 2차 내용 기반 중복 판정 (haiku)
    // classify로 종목이 확정됐으므로, 같은 종목 + 유사도 애매구간 후보만 AI로 비교한다.
    // 명백한 중복은 위 1차 문자열 dedup에서, 명백한 신규는 여기서 AI 호출 없이 통과한다.
    const aiDup = await checkDuplicateAi(
      {
        title: p.normalizedTitle,
        body: p.description,
        relatedStocks: classification.related_stocks,
      },
      recent,
    );
    dedupCalls += aiDup.aiCalls;
    dedupInTok += aiDup.inputTokens;
    dedupOutTok += aiDup.outputTokens;
    if (aiDup.isDuplicate) {
      await logProcessing({
        source: SOURCE,
        external_id: p.externalId,
        stage: 'dedup',
        status: 'duplicate',
        reason: aiDup.reason ?? 'AI 내용 중복',
      });
      continue;
    }

    // 6) 게시 대상 → news insert (신규일 때만)
    const stockIds = classification.related_stocks
      .map((n) => STOCK_ID_BY_NAME_EN[n])
      .filter((id): id is string => Boolean(id));

    const newsId = await insertNewsIfNew({
      source: SOURCE,
      external_id: p.externalId,
      category: 'news',
      title: p.normalizedTitle,
      url: p.link,
      published_at: p.pubDate,
      body: p.description,
      canonical_url: p.canonicalUrl,
      subcategory: classification.category,
      status: 'collected',
    });

    if (!newsId) {
      // 동시에 다른 경로로 이미 들어온 경우
      await logProcessing({
        source: SOURCE,
        external_id: p.externalId,
        stage: 'dedup',
        status: 'duplicate',
        reason: 'DB unique 충돌 (이미 존재)',
      });
      continue;
    }

    // 종목 연결
    await linkNewsStocks(newsId, stockIds);

    // 7) Claude brief (sonnet)
    try {
      const brief = await generateNewsBrief({
        title: p.normalizedTitle,
        description: p.description,
      });
      await updateNews(SOURCE, p.externalId, {
        translated_title: brief.translated_title,
        summary: brief.summary,
        key_points: brief.key_points,
        subcategory: classification.category,
        related_stocks: classification.related_stocks,
        confidence: classification.confidence,
        status: 'published',
      });
      publishedCount++;
      await logProcessing({
        source: SOURCE,
        external_id: p.externalId,
        stage: 'brief',
        status: 'published',
      });

      // 게시 직후 5개 언어 선제 번역 (목록/상세 첫 노출부터 번역어).
      // 번역 실패는 게시에 영향 없음 — lazy 조회 때 보강된다.
      try {
        await pretranslateNews(newsId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`NAVER 선제 번역 실패 (news=${newsId}):`, msg);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await logProcessing({
        source: SOURCE,
        external_id: p.externalId,
        stage: 'brief',
        status: 'gpt_brief_failed',
        reason: msg,
      });
    }
  }

  // ── 비용 계측 요약 (이번 주기 haiku 토큰 사용량) ──
  // haiku 입력 $1/1M, 출력 $5/1M 기준 주기 비용 추정.
  const haikuInTok = classifyInTok + dedupInTok;
  const haikuOutTok = classifyOutTok + dedupOutTok;
  const haikuCost = (haikuInTok * 1.0 + haikuOutTok * 5.0) / 1_000_000;
  logger.info(
    `NAVER 수집 완료 — 게시 ${publishedCount}건 / 후보 ${prepared.length}건 / ` +
      `분류캐시 스킵 ${cacheSkippedCount}건`,
  );
  logger.info(
    `[COST] classify ${classifyCalls}회(in ${classifyInTok}/out ${classifyOutTok}) · ` +
      `dedup ${dedupCalls}회(in ${dedupInTok}/out ${dedupOutTok}) · ` +
      `haiku $${haikuCost.toFixed(4)}/주기`,
  );

  // 주기당 1행으로 DB 적재 → 일별 집계로 진짜 비용원 확정.
  await logProcessing({
    source: SOURCE,
    external_id: `cost-metric-${new Date().toISOString()}`,
    stage: 'cost_metric',
    status: 'naver_cycle',
    reason: `haiku $${haikuCost.toFixed(4)}`,
    meta: {
      classifyCalls,
      classifyInTok,
      classifyOutTok,
      dedupCalls,
      dedupInTok,
      dedupOutTok,
      haikuInTok,
      haikuOutTok,
      candidates: prepared.length,
      published: publishedCount,
    },
  });
}
