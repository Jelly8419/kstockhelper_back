/**
 * NAVER 주기별 비용 계측(cost_metric) 집계 — 배포 후 실행.
 * classify vs dedup의 실제 호출 수·입력 토큰을 직접 측정한 값으로,
 * 콘솔 Haiku 입력 토큰의 진짜 출처를 확정한다.
 *
 * 실행: npx tsx scripts/readCostMetrics.ts
 */
import { supabase } from '../src/config/supabase';

interface CostMeta {
  classifyCalls: number;
  classifyInTok: number;
  classifyOutTok: number;
  dedupCalls: number;
  dedupInTok: number;
  dedupOutTok: number;
  haikuInTok: number;
  haikuOutTok: number;
  candidates: number;
  published: number;
}

async function main(): Promise<void> {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('processing_logs')
    .select('created_at,meta')
    .eq('stage', 'cost_metric')
    .gte('created_at', since)
    .order('created_at', { ascending: true });

  if (error) throw new Error(error.message);
  const rows = (data ?? []) as { created_at: string; meta: CostMeta | null }[];

  if (rows.length === 0) {
    console.log('\n아직 cost_metric 데이터 없음 — 배포 후 NAVER 주기가 1회 이상 돌아야 함.\n');
    process.exit(0);
  }

  // 일별 합산
  const byDay: Record<string, CostMeta & { cycles: number }> = {};
  for (const r of rows) {
    if (!r.meta) continue;
    const d = r.created_at.slice(0, 10);
    byDay[d] ??= {
      classifyCalls: 0,
      classifyInTok: 0,
      classifyOutTok: 0,
      dedupCalls: 0,
      dedupInTok: 0,
      dedupOutTok: 0,
      haikuInTok: 0,
      haikuOutTok: 0,
      candidates: 0,
      published: 0,
      cycles: 0,
    };
    const a = byDay[d];
    const m = r.meta;
    a.classifyCalls += m.classifyCalls;
    a.classifyInTok += m.classifyInTok;
    a.classifyOutTok += m.classifyOutTok;
    a.dedupCalls += m.dedupCalls;
    a.dedupInTok += m.dedupInTok;
    a.dedupOutTok += m.dedupOutTok;
    a.haikuInTok += m.haikuInTok;
    a.haikuOutTok += m.haikuOutTok;
    a.published += m.published;
    a.cycles += 1;
  }

  console.log('\n=== NAVER 일별 haiku 토큰 (실측 계측) ===\n');
  console.log('일자        주기  분류호출 분류입력   dedup호출 dedup입력   haiku입력  haiku비용');
  let totalCost = 0;
  for (const [d, a] of Object.entries(byDay).sort()) {
    const cost = (a.haikuInTok * 1.0 + a.haikuOutTok * 5.0) / 1_000_000;
    totalCost += cost;
    console.log(
      `${d}  ${String(a.cycles).padStart(4)}  ${String(a.classifyCalls).padStart(7)} ${String(a.classifyInTok).padStart(8)}   ${String(a.dedupCalls).padStart(7)} ${String(a.dedupInTok).padStart(8)}   ${String(a.haikuInTok).padStart(8)}  $${cost.toFixed(4)}`,
    );
  }

  const days = Object.keys(byDay).length;
  console.log('─'.repeat(80));
  console.log(`${days}일 haiku 합계: $${totalCost.toFixed(3)}  →  일평균 $${(totalCost / days).toFixed(3)}  →  월 환산 ~$${((totalCost / days) * 30).toFixed(2)}`);
  console.log('\n해석: classify입력 vs dedup입력 비교 → 어느 쪽이 진짜 비용원인지 확정.');
  console.log('     이 합계 + sonnet(brief/dart)을 더해 콘솔 청구액과 대조.\n');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
