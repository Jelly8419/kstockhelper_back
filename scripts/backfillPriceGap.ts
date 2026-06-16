/**
 * Price Gap 과거 1분봉 백필 실행 스크립트.
 *
 * 사용법:
 *   npx tsx scripts/backfillPriceGap.ts --dry              # 첫 영업일만 매칭 검증(DB 미적재)
 *   npx tsx scripts/backfillPriceGap.ts                    # 2026-06-02 ~ 어제(KST) 전체 적재
 *   npx tsx scripts/backfillPriceGap.ts 20260602 20260613  # 기간 지정
 *
 * 실행 전 holiday 캐시를 prime해 휴장일을 제외한다. 완료 후 자동 종료(좀비 방지).
 */
import { backfillRange } from '../src/priceGap/backfill';
import { refreshHolidayCache } from '../src/priceGap/holiday';
import { kstYmd } from '../src/collectors/publicCommon';
import { logger } from '../src/utils/logger';

const DEFAULT_START = '20260602'; // PRD §13.1 백필 시작일

function yesterdayKstYmd(): string {
  const d = new Date(Date.now() - 24 * 60 * 60 * 1000);
  return kstYmd(d);
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry');
  const positional = args.filter((a) => !a.startsWith('--'));
  const startYmd = positional[0] ?? DEFAULT_START;
  const endYmd = positional[1] ?? yesterdayKstYmd();

  logger.info(`[Backfill] 시작 — ${startYmd}~${endYmd}${dryRun ? ' (DRY-RUN)' : ''}`);
  // 휴장일 제외를 위해 캐시 prime (실패해도 안전 폴백: 개장 간주)
  await refreshHolidayCache();

  const result = await backfillRange(startYmd, endYmd, dryRun);

  logger.info(
    `[Backfill] 완료 — 영업일 ${result.days.length}일, upserted=${result.totalUpserted}` +
      `${dryRun ? ' (DRY-RUN이라 DB 미적재)' : ''}`,
  );
  if (dryRun) {
    logger.info('[Backfill] DRY-RUN 매칭 결과:');
    for (const d of result.perDay) {
      logger.info(`  ${d.ymd}: ${JSON.stringify(d.matchedByPair)}`);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[Backfill] 실패: ${msg}`);
    if (err?.response?.data) logger.error(`  응답: ${JSON.stringify(err.response.data).slice(0, 300)}`);
    process.exit(1);
  });
