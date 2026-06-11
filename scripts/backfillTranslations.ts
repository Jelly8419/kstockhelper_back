/**
 * 기존 게시 뉴스 전체를 5개 언어로 선제 번역(백필).
 *
 * - pretranslateNews를 재사용 → 이미 번역된 (기사,언어)는 자동 스킵 (재실행 안전).
 * - 게시(status=published)된 뉴스만 대상.
 * - 진행률·누적 비용 출력. 중간에 끊겨도 다시 실행하면 남은 것만 처리.
 *
 * 실행:
 *   npx tsx scripts/backfillTranslations.ts            # 전체
 *   npx tsx scripts/backfillTranslations.ts --limit=20 # 앞 20건만 (테스트)
 */
import { supabase } from '../src/config/supabase';
import { pretranslateNews } from '../src/services/translation.service';
import { CONTENT_LOCALES } from '../src/types';

const args = process.argv.slice(2);
const limitArg = args.find((a) => a.startsWith('--limit='));
const LIMIT = limitArg ? Number(limitArg.split('=')[1]) : Infinity;

// haiku 번역 1건 실측 단가(검증값): 입력~436 + 출력~613 → 약 $0.0035
const COST_PER_TRANSLATION = (436 * 1.0 + 613 * 5.0) / 1_000_000;

async function fetchPublishedIds(): Promise<string[]> {
  const ids: string[] = [];
  let from = 0;
  const page = 1000;
  for (;;) {
    const { data, error } = await supabase
      .from('news')
      .select('id')
      .eq('status', 'published')
      .order('created_at', { ascending: false })
      .range(from, from + page - 1);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    ids.push(...data.map((r) => String(r.id)));
    if (data.length < page) break;
    from += page;
  }
  return ids;
}

async function main(): Promise<void> {
  const allIds = await fetchPublishedIds();
  const ids = Number.isFinite(LIMIT) ? allIds.slice(0, LIMIT) : allIds;

  console.log(`\n=== 번역 백필 시작 ===`);
  console.log(`게시 뉴스: ${allIds.length}건${Number.isFinite(LIMIT) ? ` (이번 실행 ${ids.length}건)` : ''}`);
  console.log(`언어: ${CONTENT_LOCALES.join(', ')} (${CONTENT_LOCALES.length}개)`);
  console.log(`예상 최대 비용: ~$${(ids.length * CONTENT_LOCALES.length * COST_PER_TRANSLATION).toFixed(2)} (이미 번역된 건 스킵되어 실제는 더 적음)\n`);

  let totalCreated = 0;
  let processed = 0;
  for (const id of ids) {
    try {
      const created = await pretranslateNews(id);
      totalCreated += created;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ❌ news=${id} 실패: ${msg}`);
    }
    processed++;
    if (processed % 10 === 0 || processed === ids.length) {
      const cost = totalCreated * COST_PER_TRANSLATION;
      console.log(
        `  진행 ${processed}/${ids.length} — 신규 번역 ${totalCreated}건 (누적 ~$${cost.toFixed(3)})`,
      );
    }
  }

  console.log(`\n=== 완료 ===`);
  console.log(`총 신규 번역: ${totalCreated}건 / 누적 비용 ~$${(totalCreated * COST_PER_TRANSLATION).toFixed(3)}`);
  console.log(`(다시 실행하면 남은 미번역분만 처리됩니다)\n`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
