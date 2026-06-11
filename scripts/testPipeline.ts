/**
 * 파이프라인 통합 테스트 스크립트 (스케줄러와 독립).
 *
 * 실행:
 *   npm run test:pipeline              # 실제 DB insert/update (테스트 데이터로 표시)
 *   npm run test:pipeline -- --dry-run # DB 쓰기 없이 결과만 출력
 *   npm run test:pipeline -- --only=dart
 *   npm run test:pipeline -- --only=naver
 *
 * 특징:
 *   - DART: 종목별 최근 공시 5건, 중복 체크 무시하고 강제로 translate까지
 *   - NAVER: 종목별 검색 10건(합산 후 상한), 중복 체크 무시하고 classify→brief까지
 *   - 실제 스케줄러/콜렉터 로직은 건드리지 않고, 동일 파이프라인 모듈을 재사용
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
import type {
  DartListResponse,
  DartDisclosure,
  NaverNewsResponse,
  NaverNewsItem,
} from '../src/types';

// ===== CLI 옵션 =====
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const onlyArg = args.find((a) => a.startsWith('--only='));
const ONLY = onlyArg ? onlyArg.split('=')[1] : 'all';

const DART_PER_STOCK = 5;
const NAVER_PER_STOCK = 10;

const DART_LIST_URL = 'https://opendart.fss.or.kr/api/list.json';
const DART_VIEWER_URL = 'https://dart.fss.or.kr/dsaf001/main.do';
const NAVER_NEWS_URL = 'https://openapi.naver.com/v1/search/news.json';

// ===== 로그 헬퍼 =====
const tag = (s: string) => `[TEST]${DRY_RUN ? '[DRY-RUN]' : ''} ${s}`;
function line() {
  console.log('─'.repeat(70));
}

/** rcept_dt(YYYYMMDD) → ISO (KST 자정). 실패 시 현재시각 */
function rceptDtToIso(rceptDt: string): string {
  if (/^\d{8}$/.test(rceptDt)) {
    return `${rceptDt.slice(0, 4)}-${rceptDt.slice(4, 6)}-${rceptDt.slice(6, 8)}T00:00:00+09:00`;
  }
  return new Date().toISOString();
}

/** Naver pubDate(RFC1123) → ISO. 실패 시 현재시각 */
function pubDateToIso(pubDate: string): string {
  const t = Date.parse(pubDate);
  return Number.isNaN(t) ? new Date().toISOString() : new Date(t).toISOString();
}

/** Error / Supabase 에러 객체 / 문자열 모두 사람이 읽을 수 있게 변환 */
function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object') {
    const e = err as { message?: string; hint?: string; code?: string };
    if (e.message) return `${e.message}${e.hint ? ` (hint: ${e.hint})` : ''}`;
    return JSON.stringify(err);
  }
  return String(err);
}

// ===== DART 테스트 =====

/** 최근 1년 범위에서 종목별 최근 공시 N건 조회 */
async function fetchRecentDisclosures(corpCode: string, count: number): Promise<DartDisclosure[]> {
  const end = new Date();
  const begin = new Date(end.getTime() - 365 * 24 * 60 * 60 * 1000);
  const ymd = (d: Date) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Seoul',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .format(d)
      .replace(/-/g, '');

  const { data } = await axios.get<DartListResponse>(DART_LIST_URL, {
    params: {
      crtfc_key: env.dartApiKey,
      corp_code: corpCode,
      bgn_de: ymd(begin),
      end_de: ymd(end),
      page_count: count,
      page_no: 1,
    },
    timeout: 10_000,
  });
  if (data.status === '013') return [];
  if (data.status !== '000') {
    throw new Error(`DART API 오류 (status=${data.status}): ${data.message}`);
  }
  return (data.list ?? []).slice(0, count);
}

async function testDart(): Promise<void> {
  console.log(tag('===== DART 파이프라인 테스트 시작 ====='));

  let translated = 0;
  let skippedType = 0;
  let failed = 0;

  for (const stock of STOCKS) {
    const disclosures = await fetchRecentDisclosures(stock.corpCode, DART_PER_STOCK);
    console.log(tag(`[${stock.name}] 최근 공시 ${disclosures.length}건 조회`));

    for (const d of disclosures) {
      line();
      console.log(tag(`공시: ${d.report_nm} (rcept_no=${d.rcept_no})`));

      const publishable = isPublishableDisclosure(d.report_nm);
      console.log(tag(`게시 대상 유형: ${publishable ? 'YES' : 'NO (translate 생략)'}`));

      // 강제 insert (중복 무시: 이미 있으면 null이지만 테스트는 계속 진행)
      if (!DRY_RUN) {
        const newsId = await insertNewsIfNew({
          source: 'DART',
          external_id: d.rcept_no,
          category: 'disclosure',
          title: d.report_nm,
          url: `${DART_VIEWER_URL}?rcpNo=${d.rcept_no}`,
          published_at: rceptDtToIso(d.rcept_dt),
          status: 'collected',
        });
        console.log(tag(`news insert: ${newsId ? '신규(id=' + newsId + ')' : '이미 존재(중복 무시하고 진행)'}`));
        if (newsId) await linkNewsStocks(newsId, [stock.stockId]);
      }

      if (!publishable) {
        skippedType++;
        continue;
      }

      try {
        const content = await fetchDisclosureText(d.rcept_no);
        console.log(tag(`document.xml 본문: ${content.length}자`));

        const result = await translateDisclosure({ reportNm: d.report_nm, content });
        translated++;

        console.log(tag(`→ translated_title: ${result.translated_title}`));
        console.log(tag(`→ summary: ${result.summary.slice(0, 160)}...`));
        console.log(tag(`→ key_figures: ${JSON.stringify(result.key_figures)}`));
        console.log(tag(`→ key_points: ${result.key_points.length}개`));

        if (!DRY_RUN) {
          await updateNews('DART', d.rcept_no, {
            translated_title: result.translated_title,
            english_translation: result.english_translation,
            summary: result.summary,
            key_figures: result.key_figures,
            key_points: result.key_points,
            status: 'published',
          });
          console.log(tag('news update 완료 (status=published)'));
        }
      } catch (err) {
        failed++;
        const msg = errMsg(err);
        console.error(tag(`translate 실패: ${msg}`));
      }
    }
  }

  line();
  console.log(tag(`DART 결과 — 번역 ${translated} / 유형스킵 ${skippedType} / 실패 ${failed}`));
}

// ===== NAVER 테스트 =====

async function searchNews(keyword: string, display: number): Promise<NaverNewsItem[]> {
  const { data } = await axios.get<NaverNewsResponse>(NAVER_NEWS_URL, {
    params: { query: keyword, display, sort: 'date' },
    headers: {
      'X-Naver-Client-Id': env.naverClientId,
      'X-Naver-Client-Secret': env.naverClientSecret,
    },
    timeout: 10_000,
  });
  return data.items ?? [];
}

async function testNaver(): Promise<void> {
  console.log(tag('===== NAVER 파이프라인 테스트 시작 ====='));

  let published = 0;
  let classifySkip = 0;
  let failed = 0;

  for (const stock of STOCKS) {
    const items = await searchNews(stock.name, NAVER_PER_STOCK);
    console.log(tag(`[${stock.name}] 검색 결과 ${items.length}건`));

    for (const item of items) {
      line();
      const link = item.originallink || item.link;
      const canonicalUrl = normalizeUrl(link);
      const title = normalizeTitle(item.title);
      const description = normalizeTitle(item.description);

      console.log(tag(`뉴스: ${title}`));
      console.log(tag(`canonical_url: ${canonicalUrl}`));

      let classification;
      try {
        ({ result: classification } = await classifyNews({ title, description }));
      } catch (err) {
        failed++;
        const msg = errMsg(err);
        console.error(tag(`classify 실패: ${msg}`));
        continue;
      }

      console.log(
        tag(
          `classify → ${classification.decision} / conf ${classification.confidence} / ` +
            `${classification.category} / stocks=${JSON.stringify(classification.related_stocks)}`,
        ),
      );
      console.log(tag(`reason: ${classification.reason}`));

      if (!shouldPublish(classification)) {
        classifySkip++;
        console.log(tag('게시조건 미충족 → skip'));
        continue;
      }

      const stockIds = classification.related_stocks
        .map((n) => STOCK_ID_BY_NAME_EN[n])
        .filter((id): id is string => Boolean(id));

      if (!DRY_RUN) {
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
        console.log(
          tag(`news insert: ${newsId ? '신규(id=' + newsId + ')' : '이미 존재(중복 무시하고 진행)'}`),
        );
        if (newsId) await linkNewsStocks(newsId, stockIds);
      }

      try {
        const brief = await generateNewsBrief({ title, description });
        published++;
        console.log(tag(`→ translated_title: ${brief.translated_title}`));
        console.log(tag(`→ summary: ${brief.summary.slice(0, 160)}...`));
        console.log(tag(`→ key_points: ${brief.key_points.length}개`));

        if (!DRY_RUN) {
          await updateNews('NAVER', canonicalUrl, {
            translated_title: brief.translated_title,
            summary: brief.summary,
            key_points: brief.key_points,
            subcategory: classification.category,
            related_stocks: classification.related_stocks,
            confidence: classification.confidence,
            status: 'published',
          });
          console.log(tag('news update 완료 (status=published)'));
        }
      } catch (err) {
        failed++;
        const msg = errMsg(err);
        console.error(tag(`brief 실패: ${msg}`));
      }
    }
  }

  line();
  console.log(tag(`NAVER 결과 — 게시 ${published} / 분류스킵 ${classifySkip} / 실패 ${failed}`));
}

// ===== main =====
async function main(): Promise<void> {
  console.log(tag(`옵션: only=${ONLY}, dryRun=${DRY_RUN}`));
  console.log(tag(`DART ${DART_PER_STOCK}건/종목, NAVER ${NAVER_PER_STOCK}건/종목`));
  line();

  if (ONLY === 'all' || ONLY === 'dart') await testDart();
  if (ONLY === 'all' || ONLY === 'naver') await testNaver();

  line();
  console.log(tag('테스트 완료'));
  process.exit(0);
}

main().catch((err) => {
  const msg = errMsg(err);
  console.error(tag(`치명적 오류: ${msg}`));
  process.exit(1);
});
