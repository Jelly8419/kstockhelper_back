import axios from 'axios';
import { env } from '../config/env';
import { STOCKS } from '../constants/stocks';
import { logger } from '../utils/logger';
import { insertNewsIfNew, updateNews, linkNewsStocks } from '../services/news.service';
import { logProcessing } from '../services/processingLog.service';
import { isPublishableDisclosure } from '../constants/disclosureTypes';
import { fetchDisclosureText } from './dartDocument';
import { translateDisclosure } from '../pipeline/dartTranslate';
import type { DartListResponse, DartDisclosure, NewsInsert } from '../types';

const DART_LIST_URL = 'https://opendart.fss.or.kr/api/list.json';
const DART_VIEWER_URL = 'https://dart.fss.or.kr/dsaf001/main.do';

/** YYYYMMDD (KST) — DART 조회 기간 파라미터용 */
function todayKstYmd(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}${get('month')}${get('day')}`;
}

/** rcept_dt(YYYYMMDD) → ISO timestamp (KST 자정 기준). 파싱 실패 시 현재시각 */
function rceptDtToIso(rceptDt: string): string {
  if (!/^\d{8}$/.test(rceptDt)) return new Date().toISOString();
  const y = rceptDt.slice(0, 4);
  const m = rceptDt.slice(4, 6);
  const d = rceptDt.slice(6, 8);
  return `${y}-${m}-${d}T00:00:00+09:00`;
}

function toNewsInsert(d: DartDisclosure): NewsInsert {
  return {
    source: 'DART',
    external_id: d.rcept_no,
    category: 'disclosure',
    title: d.report_nm,
    url: `${DART_VIEWER_URL}?rcpNo=${d.rcept_no}`,
    published_at: rceptDtToIso(d.rcept_dt),
    status: 'collected',
  };
}

/** 단일 종목의 당일 공시 목록 조회 */
async function fetchDisclosures(corpCode: string): Promise<DartDisclosure[]> {
  const today = todayKstYmd();
  const { data } = await axios.get<DartListResponse>(DART_LIST_URL, {
    params: {
      crtfc_key: env.dartApiKey,
      corp_code: corpCode,
      bgn_de: today,
      end_de: today,
      page_count: 100,
    },
    timeout: 10_000,
  });

  // status 000: 정상, 013: 조회된 데이터 없음(정상적인 빈 결과)
  if (data.status === '013') return [];
  if (data.status !== '000') {
    throw new Error(`DART API 오류 (status=${data.status}): ${data.message}`);
  }
  return data.list ?? [];
}

/**
 * 신규 공시 1건을 처리한다.
 * - 게시 대상 유형이면 본문 확보 → Claude 번역/요약 → news 갱신
 * - 대상이 아니면 disclosure_type_unconfirmed 로그 후 수집만 유지
 */
async function processNewDisclosure(d: DartDisclosure): Promise<void> {
  if (!isPublishableDisclosure(d.report_nm)) {
    await logProcessing({
      source: 'DART',
      external_id: d.rcept_no,
      stage: 'dart_translate',
      status: 'disclosure_type_unconfirmed',
      reason: d.report_nm,
    });
    return;
  }

  // 본문 확보 (실패해도 빈 문자열로 진행)
  const content = await fetchDisclosureText(d.rcept_no);

  try {
    const result = await translateDisclosure({ reportNm: d.report_nm, content });
    await updateNews('DART', d.rcept_no, {
      translated_title: result.translated_title,
      english_translation: result.english_translation,
      summary: result.summary,
      key_figures: result.key_figures,
      key_points: result.key_points,
      status: 'published',
    });
    await logProcessing({
      source: 'DART',
      external_id: d.rcept_no,
      stage: 'dart_translate',
      status: 'published',
      reason: d.report_nm,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logProcessing({
      source: 'DART',
      external_id: d.rcept_no,
      stage: 'dart_translate',
      status: 'gpt_brief_failed',
      reason: msg,
    });
  }
}

/**
 * 전 종목 공시를 수집해 news 테이블에 저장하고, 신규 공시 중 게시 대상 유형은
 * Claude 번역/요약 파이프라인을 태운다.
 * 한 종목/한 건 실패가 전체를 중단시키지 않도록 격리한다.
 */
export async function collectDartDisclosures(): Promise<void> {
  let totalInserted = 0;
  let totalTranslated = 0;

  for (const stock of STOCKS) {
    try {
      const disclosures = await fetchDisclosures(stock.corpCode);
      if (disclosures.length === 0) continue;

      for (const d of disclosures) {
        // 신규일 때만 파이프라인 진행 (중복은 unique 제약으로 null)
        const newsId = await insertNewsIfNew(toNewsInsert(d));
        if (!newsId) continue;
        totalInserted++;

        // 종목 연결 (현재 루프의 종목)
        await linkNewsStocks(newsId, [stock.stockId]);

        if (isPublishableDisclosure(d.report_nm)) totalTranslated++;
        await processNewDisclosure(d);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`DART [${stock.name}] 수집 실패:`, msg);
    }
  }

  if (totalInserted === 0) {
    logger.info('DART 수집 완료 — 신규 공시 없음');
  } else {
    logger.info(`DART 수집 완료 — 신규 ${totalInserted}건 (번역 대상 ${totalTranslated}건)`);
  }
}
