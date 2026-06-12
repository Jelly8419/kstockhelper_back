/**
 * 기존 게시 뉴스/공시에 SEO URL용 slug를 채우는 1회성 백필 스크립트.
 *
 * - slug가 아직 없는(null) published 행만 대상 (재실행 안전).
 * - slug는 영문 제목(translated_title) 기준, 없으면 title로 생성.
 *   slugify 결과가 비면(비영문 등) null로 남겨둔다 (프론트가 런타임 fallback).
 * - id 단위로 직접 update (publish 경로의 updateNews는 source+external_id 기준이라 별도 처리).
 *
 * 실행:
 *   npx tsx scripts/backfillSlug.ts             # 전체
 *   npx tsx scripts/backfillSlug.ts --dry-run   # DB 쓰기 없이 시뮬레이션
 *   npx tsx scripts/backfillSlug.ts --limit=20  # 앞 20건만 (테스트)
 */
import { supabase } from '../src/config/supabase';
import { buildSlug } from '../src/utils/slug';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const limitArg = args.find((a) => a.startsWith('--limit='));
const LIMIT = limitArg ? Number(limitArg.split('=')[1]) : Infinity;

interface Row {
  id: string;
  translated_title: string | null;
  title: string | null;
}

/** slug가 비어있는 published 행을 페이지네이션으로 모두 가져온다. */
async function fetchRowsNeedingSlug(): Promise<Row[]> {
  const rows: Row[] = [];
  let from = 0;
  const page = 1000;
  for (;;) {
    const { data, error } = await supabase
      .from('news')
      .select('id, translated_title, title')
      .eq('status', 'published')
      .is('slug', null)
      .order('created_at', { ascending: false })
      .range(from, from + page - 1);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    rows.push(...(data as Row[]));
    if (data.length < page) break;
    from += page;
  }
  return rows;
}

async function main(): Promise<void> {
  const all = await fetchRowsNeedingSlug();
  const rows = Number.isFinite(LIMIT) ? all.slice(0, LIMIT) : all;

  console.log(`\n=== slug 백필 시작 ${DRY_RUN ? '(dry-run)' : ''} ===`);
  console.log(`slug 없는 게시 행: ${all.length}건${Number.isFinite(LIMIT) ? ` (이번 실행 ${rows.length}건)` : ''}\n`);

  let updated = 0;
  let skippedNoSlug = 0;
  let processed = 0;

  for (const r of rows) {
    const slug = buildSlug(r.translated_title ?? r.title);
    if (!slug) {
      // 영문 slug를 만들 수 없는 제목 (비영문 등) — null로 남겨둔다.
      skippedNoSlug++;
    } else if (DRY_RUN) {
      updated++;
    } else {
      const { error } = await supabase.from('news').update({ slug }).eq('id', r.id);
      if (error) {
        console.error(`  ❌ news=${r.id} 실패: ${error.message}`);
      } else {
        updated++;
      }
    }

    processed++;
    if (processed % 50 === 0 || processed === rows.length) {
      console.log(`  진행 ${processed}/${rows.length} — slug 부여 ${updated}건, slug 불가 ${skippedNoSlug}건`);
    }
  }

  console.log(`\n=== 완료 ===`);
  console.log(`slug 부여: ${updated}건 / slug 불가(영문 제목 없음): ${skippedNoSlug}건`);
  if (DRY_RUN) console.log(`(dry-run — 실제 DB 쓰기는 없었습니다)`);
  console.log(`(다시 실행하면 slug가 비어있는 행만 처리됩니다)\n`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
