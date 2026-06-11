/**
 * 런칭 전 초기 데이터 백필 스크립트 (스케줄러와 독립).
 *
 * 목표: 종목당 published 데이터를 TARGET개까지 채운다.
 *   - 1순위: DART 과거 공시(게시 대상 유형) 번역
 *   - 2순위(보충): 네이버 뉴스 classify 통과분
 * 이미 published 인 건수는 제외하고 부족분만 처리한다.
 *
 * 실행:
 *   npm run seed                 # 실제 DB 쓰기
 *   npm run seed -- --dry-run    # DB 쓰기 없이 시뮬레이션
 *   npm run seed -- --target=10  # 종목당 목표 개수 (기본 10)
 *   npm run seed -- --only=dart  # DART만 / --only=naver
 */
import axios from 'axios';
import { env } from '../src/config/env';
import { STOCKS, STOCK_ID_BY_NAME_EN } from '../src/constants/stocks';
import { isPublishableDisclosure } from '../src/constants/disclosureTypes';
import { fetchDisclosureText } from '../src/collectors/dartDocument';
import { translateDisclosure } from '../src/pipeline/dartTranslate';
import { classifyNews, shouldPublish } from '../src/pipeline/classify';
import { generateNewsBrief } from '../src/pipeline/newsBrief';
import { normalizeUrl } from '../src/utils/urlNormalize';
import { normalizeTitle } from '../src/utils/titleNormalize';
import { insertNewsIfNew, updateNews, linkNewsStocks } from '../src/services/news.service';
import { supabase } from '../src/config/supabase';
import type {
  DartListResponse,
  DartDisclosure,
  NaverNewsResponse,
  NaverNewsItem,
} from '../src/types';
import type { StockMeta as _StockMeta } from '../src/constants/stocks';

// ===== CLI =====
const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const targetArg = argv.find((a) => a.startsWith('--target='));
const TARGET = targetArg ? Number(targetArg.split('=')[1]) : 10;
const onlyArg = argv.find((a) => a.startsWith('--only='));
const ONLY = onlyArg ? onlyArg.split('=')[1] : 'all';

const DART_LIST_URL = 'https://opendart.fss.or.kr/api/list.json';
const DART_VIEWER_URL = 'https://dart.fss.or.kr/dsaf001/main.do';
const NAVER_NEWS_URL = 'https://openapi.naver.com/v1/search/news.json';
const DART_MAX_PAGES = 5; // 종목당 최대 조회 페이지 (page_count 100)
const NAVER_DISPLAY = 100;

const tag = (s: string) => `[SEED]${DRY_RUN ? '[DRY-RUN]' : ''} ${s}`;
const line = () => console.log('─'.repeat(70));

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object') {
    const e = err as { message?: string; hint?: string };
    if (e.message) return `${e.message}${e.hint ? ` (hint: ${e.hint})` : ''}`;
    return JSON.stringify(err);
  }
  return String(err);
}

const ymd = (d: Date) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(d)
    .replace(/-/g, '');

function rceptDtToIso(rceptDt: string): string {
  if (/^\d{8}$/.test(rceptDt)) {
    return `${rceptDt.slice(0, 4)}-${rceptDt.slice(4, 6)}-${rceptDt.slice(6, 8)}T00:00:00+09:00`;
  }
  return new Date().toISOString();
}
function pubDateToIso(pubDate: string): string {
  const t = Date.parse(pubDate);
  return Number.isNaN(t) ? new Date().toISOString() : new Date(t).toISOString();
}

/** 종목별 현재 published 개수 (news_stocks 조인) */
async function publishedCount(stockId: string): Promise<number> {
  const { data, error } = await supabase
    .from('news_stocks')
    .select('news_id, news!inner(status)')
    .eq('stock_id', stockId)
    .eq('news.status', 'published');
  if (error) throw error;
  return data?.length ?? 0;
}

/** 종목별 과거 1년 공시 (게시 대상 유형만, 최신순) */
async function fetchPublishableDisclosures(corpCode: string): Promise<DartDisclosure[]> {
  const end = new Date();
  const begin = new Date(end.getTime() - 365 * 24 * 60 * 60 * 1000);
  const out: DartDisclosure[] = [];

  for (let page = 1; page <= DART_MAX_PAGES; page++) {
    const { data } = await axios.get<DartListResponse>(DART_LIST_URL, {
      params: {
        crtfc_key: env.dartApiKey,
        corp_code: corpCode,
        bgn_de: ymd(begin),
        end_de: ymd(end),
        page_count: 100,
        page_no: page,
      },
      timeout: 10_000,
    });
    if (data.status === '013') break;
    if (data.status !== '000') throw new Error(`DART status=${data.status}: ${data.message}`);

    const list = data.list ?? [];
    out.push(...list.filter((d) => isPublishableDisclosure(d.report_nm)));

    if (!data.total_page || page >= data.total_page) break;
  }
  return out;
}

/** DART 백필: 종목별 부족분만큼 번역해 published */
async function seedDartForStock(stock: _StockMeta, need: number): Promise<number> {
  if (need <= 0) return 0;
  const disclosures = await fetchPublishableDisclosures(stock.corpCode);
  console.log(tag(`[${stock.name}] 게시대상 공시 ${disclosures.length}건 후보, 목표 +${need}`));

  let done = 0;
  for (const d of disclosures) {
    if (done >= need) break;

    const newsId = DRY_RUN
      ? 'dry'
      : await insertNewsIfNew({
          source: 'DART',
          external_id: d.rcept_no,
          category: 'disclosure',
          title: d.report_nm,
          url: `${DART_VIEWER_URL}?rcpNo=${d.rcept_no}`,
          published_at: rceptDtToIso(d.rcept_dt),
          status: 'collected',
        });

    // 이미 존재(null)면 — 이미 처리된 공시일 수 있어 건너뜀 (중복 카운트 방지)
    if (!newsId) continue;
    if (!DRY_RUN) await linkNewsStocks(newsId, [stock.stockId]);

    try {
      const content = DRY_RUN ? '' : await fetchDisclosureText(d.rcept_no);
      if (DRY_RUN) {
        console.log(tag(`  (dry) 번역 예정: ${d.report_nm} (${d.rcept_no})`));
        done++;
        continue;
      }
      const result = await translateDisclosure({ reportNm: d.report_nm, content });
      await updateNews('DART', d.rcept_no, {
        translated_title: result.translated_title,
        english_translation: result.english_translation,
        summary: result.summary,
        key_figures: result.key_figures,
        key_points: result.key_points,
        status: 'published',
      });
      done++;
      console.log(tag(`  ✅ ${done}/${need} ${result.translated_title}`));
    } catch (err) {
      console.error(tag(`  ❌ 번역 실패 ${d.rcept_no}: ${errMsg(err)}`));
    }
  }
  return done;
}

async function searchNews(keyword: string): Promise<NaverNewsItem[]> {
  const { data } = await axios.get<NaverNewsResponse>(NAVER_NEWS_URL, {
    params: { query: keyword, display: NAVER_DISPLAY, sort: 'date' },
    headers: {
      'X-Naver-Client-Id': env.naverClientId,
      'X-Naver-Client-Secret': env.naverClientSecret,
    },
    timeout: 10_000,
  });
  return data.items ?? [];
}

/** 뉴스 보충: 종목별 부족분만큼 classify 통과분을 published */
async function seedNaverForStock(stock: _StockMeta, need: number): Promise<number> {
  if (need <= 0) return 0;
  const items = await searchNews(stock.name);
  console.log(tag(`[${stock.name}] 뉴스 ${items.length}건 후보, 목표 +${need}`));

  let done = 0;
  for (const item of items) {
    if (done >= need) break;
    const link = item.originallink || item.link;
    const canonicalUrl = normalizeUrl(link);
    const title = normalizeTitle(item.title);
    const description = normalizeTitle(item.description);

    let classification;
    try {
      ({ result: classification } = await classifyNews({ title, description }));
    } catch {
      continue;
    }
    if (!shouldPublish(classification)) continue;

    // 이 종목이 related_stocks에 포함될 때만 카운트
    const stockIds = classification.related_stocks
      .map((n) => STOCK_ID_BY_NAME_EN[n])
      .filter((id): id is string => Boolean(id));
    if (!stockIds.includes(stock.stockId)) continue;

    if (DRY_RUN) {
      console.log(tag(`  (dry) 게시 예정: ${title}`));
      done++;
      continue;
    }

    const newsId = await insertNewsIfNew({
      source: 'NAVER',
      external_id: canonicalUrl,
      category: 'news',
      title,
      url: link,
      published_at: pubDateToIso(item.pubDate),
      body: description,
      canonical_url: canonicalUrl,
      subcategory: classification.category,
      status: 'collected',
    });
    if (!newsId) continue;
    await linkNewsStocks(newsId, stockIds);

    try {
      const brief = await generateNewsBrief({ title, description });
      await updateNews('NAVER', canonicalUrl, {
        translated_title: brief.translated_title,
        summary: brief.summary,
        key_points: brief.key_points,
        subcategory: classification.category,
        related_stocks: classification.related_stocks,
        confidence: classification.confidence,
        status: 'published',
      });
      done++;
      console.log(tag(`  ✅ ${done}/${need} ${brief.translated_title}`));
    } catch (err) {
      console.error(tag(`  ❌ brief 실패: ${errMsg(err)}`));
    }
  }
  return done;
}

async function main(): Promise<void> {
  console.log(tag(`종목당 목표 ${TARGET}개 / only=${ONLY} / dryRun=${DRY_RUN}`));
  line();

  for (const stock of STOCKS) {
    const current = DRY_RUN ? 0 : await publishedCount(stock.stockId);
    let need = Math.max(0, TARGET - current);
    console.log(tag(`[${stock.name}] 현재 published ${current} → 부족 ${need}`));

    if (need === 0) {
      console.log(tag(`[${stock.name}] 이미 목표 도달 ✅`));
      line();
      continue;
    }

    if (ONLY === 'all' || ONLY === 'dart') {
      const got = await seedDartForStock(stock, need);
      need -= got;
      console.log(tag(`[${stock.name}] DART로 ${got}개 확보, 남은 부족 ${need}`));
    }

    if ((ONLY === 'all' || ONLY === 'naver') && need > 0) {
      const got = await seedNaverForStock(stock, need);
      need -= got;
      console.log(tag(`[${stock.name}] 뉴스로 ${got}개 보충, 남은 부족 ${need}`));
    }

    if (need > 0) {
      console.log(tag(`[${stock.name}] ⚠️ ${need}개 부족 — 후보 소진 (기간/표본 확대 필요)`));
    } else {
      console.log(tag(`[${stock.name}] 목표 달성 ✅`));
    }
    line();
  }

  console.log(tag('시드 완료'));
  process.exit(0);
}

main().catch((err) => {
  console.error(tag(`치명적 오류: ${errMsg(err)}`));
  process.exit(1);
});
