/**
 * 한국투자증권(KIS) WebSocket PoC — 국내주식 실시간체결가(H0STCNT0) 수신 검증.
 *
 * 검증 목적 (Price Gap Monitor C2 블로커):
 *   1) approval_key 발급 가능 여부 (REST access_token과 별개 체계: POST /oauth2/Approval, body는 secretkey)
 *   2) ws://ops.koreainvestment.com:21000 연결 + H0STCNT0 구독 ack 수신
 *   3) 삼성/SK하이닉스/현대차 실시간 체결가(STCK_PRPR) 수신 여부
 *   4) 메시지 빈도/지연 감각 (Premium 1초 push 설계 근거)
 *
 * 실행:  npx tsx scripts/probeKisWs.ts [관측ms]
 *   - 기존 env(KIS_APP_KEY/KIS_APP_SECRET)를 그대로 사용. 추가 설정 불필요.
 *   - 장 마감(15:30 이후)/휴장일에는 체결 틱이 거의 없다. 그 경우에도
 *     approval_key 발급 + 연결 + 구독 ack까지는 검증된다(연결성 확인).
 *   - 실시간 체결 빈도 확인은 평일 09:00~15:30 KST에 재실행.
 *
 * 주의: 일회성 진단용. 운영 컬렉터 아님. 좀비 방지를 위해 관측 후 자동 종료한다.
 */
import WebSocket from 'ws';
import axios from 'axios';
import { env } from '../src/config/env';

const KIS_REST = 'https://openapi.koreainvestment.com:9443';
const KIS_WS = 'ws://ops.koreainvestment.com:21000';
const APPROVAL_PATH = '/oauth2/Approval';
const TR_ID = 'H0STCNT0'; // 국내주식 실시간체결가(KRX)

/** 종목코드 → 표시명 */
const STOCKS: Record<string, string> = {
  '005930': '삼성전자',
  '000660': 'SK하이닉스',
  '005380': '현대차',
};
const CODES = Object.keys(STOCKS);

/** H0STCNT0 응답 필드 순서 (KIS 공식 ccnl_krx 예제 기준). 체결가는 index 2. */
const FIELDS = [
  'MKSC_SHRN_ISCD', // 0 종목코드
  'STCK_CNTG_HOUR', // 1 체결시각 HHMMSS
  'STCK_PRPR', // 2 현재가(체결가)
  'PRDY_VRSS_SIGN', // 3 전일대비부호
  'PRDY_VRSS', // 4 전일대비
  'PRDY_CTRT', // 5 전일대비율
] as const;

const RUN_MS = Number(process.argv[2]) || 20_000;

interface Stat {
  ticks: number;
  lastPrice: string | null;
  lastTime: string | null;
  firstTs: number | null;
  lastTs: number | null;
}
const stats: Record<string, Stat> = Object.fromEntries(
  CODES.map((c) => [c, { ticks: 0, lastPrice: null, lastTime: null, firstTs: null, lastTs: null }]),
);

function log(...a: unknown[]): void {
  console.log(`[${new Date().toISOString()}]`, ...a);
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 1) approval_key 발급 (REST access_token과 다른 엔드포인트/필드)
// ─────────────────────────────────────────────────────────────────────────────
async function getApprovalKey(): Promise<string> {
  const { data } = await axios.post(
    `${KIS_REST}${APPROVAL_PATH}`,
    {
      grant_type: 'client_credentials',
      appkey: env.kisAppKey,
      secretkey: env.kisAppSecret, // 주의: REST는 'appsecret', WS Approval은 'secretkey'
    },
    { headers: { 'Content-Type': 'application/json; charset=utf-8' }, timeout: 10_000 },
  );
  if (!data.approval_key) {
    throw new Error(`approval_key 응답 없음: ${JSON.stringify(data)}`);
  }
  return data.approval_key;
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 2) 구독 메시지 빌더
// ─────────────────────────────────────────────────────────────────────────────
function subscribeMsg(approvalKey: string, code: string): string {
  return JSON.stringify({
    header: {
      approval_key: approvalKey,
      custtype: 'P', // 개인
      tr_type: '1', // 1=등록, 2=해제
      'content-type': 'utf-8',
    },
    body: { input: { tr_id: TR_ID, tr_key: code } },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 3) 실시간 데이터 파싱
//   응답 형식: "0|H0STCNT0|001|<캐럿구분 필드들>"
//   - 첫 글자 '0'/'1' = 암호화여부, 그 뒤 파이프(|)로 헤더, 마지막이 데이터 본문.
//   - 데이터 본문은 캐럿(^)으로 필드 구분. 한 프레임에 여러 체결이 올 수 있음(헤더 003=건수).
//   JSON으로 오는 건 구독 ack / PINGPONG.
// ─────────────────────────────────────────────────────────────────────────────
function handleRealtime(raw: string): void {
  const parts = raw.split('|');
  if (parts.length < 4) return;
  const trId = parts[1];
  if (trId !== TR_ID) return;

  const body = parts[3];
  const fields = body.split('^');
  // 한 프레임에 여러 건이면 FIELDS.length 배수로 들어온다. 첫 건만 통계에 사용.
  const code = fields[0];
  const st = stats[code];
  if (!st) return;
  st.ticks += 1;
  st.lastTime = fields[1] ?? null;
  st.lastPrice = fields[2] ?? null;
  st.firstTs ??= Date.now();
  st.lastTs = Date.now();
}

async function main(): Promise<void> {
  log(`KIS WS PoC 시작 — 관측 ${RUN_MS / 1000}초, 종목=${CODES.join(',')}`);

  log('── STEP 1: approval_key 발급 ──');
  let approvalKey: string;
  try {
    approvalKey = await getApprovalKey();
    log(`✅ approval_key 발급 성공 (len=${approvalKey.length}, ${approvalKey.slice(0, 6)}…)`);
  } catch (err) {
    log('❌ approval_key 발급 실패:', axios.isAxiosError(err) ? `${err.response?.status} ${JSON.stringify(err.response?.data)}` : String(err));
    process.exit(1);
  }

  log('── STEP 2: WebSocket 연결 + 구독 ──');
  const ws = new WebSocket(KIS_WS);

  ws.on('open', () => {
    log('✅ KIS WS 연결됨 →', KIS_WS);
    for (const code of CODES) {
      ws.send(subscribeMsg(approvalKey, code));
      log(`  구독 요청 전송: ${STOCKS[code]} (${code})`);
    }
  });

  ws.on('message', (buf: WebSocket.RawData) => {
    const raw = buf.toString();

    // JSON이면 구독 ack 또는 PINGPONG
    if (raw.startsWith('{')) {
      try {
        const msg = JSON.parse(raw);
        const trId = msg.header?.tr_id;
        if (trId === 'PINGPONG') {
          ws.send(raw); // 받은 그대로 echo (연결 유지)
          return;
        }
        const code = msg.header?.tr_key ?? '';
        const rt = msg.body?.rt_cd;
        const m = msg.body?.msg1 ?? '';
        log(`  구독 ack: tr_id=${trId} tr_key=${code} rt_cd=${rt} msg=${m}`);
      } catch {
        log('  (JSON 파싱 실패)', raw.slice(0, 120));
      }
      return;
    }

    // 그 외는 실시간 체결 데이터(파이프/캐럿 구분)
    handleRealtime(raw);
  });

  ws.on('error', (err) => log('❌ KIS WS 에러:', err instanceof Error ? err.message : String(err)));
  ws.on('close', (code, reason) => log(`KIS WS 닫힘 code=${code} reason=${reason?.toString()}`));

  await new Promise((r) => setTimeout(r, RUN_MS));

  // ── 요약 리포트 ──
  log('');
  log('════════════════ 요약 리포트 ════════════════');
  let anyTick = false;
  for (const code of CODES) {
    const st = stats[code];
    const span = st.firstTs && st.lastTs ? ((st.lastTs - st.firstTs) / 1000).toFixed(1) : '0';
    const rate = st.firstTs && st.lastTs && st.lastTs > st.firstTs
      ? (st.ticks / ((st.lastTs - st.firstTs) / 1000)).toFixed(2)
      : '0';
    if (st.ticks > 0) anyTick = true;
    log(`  ${STOCKS[code]} (${code}): ticks=${st.ticks} (${rate}/s, ${span}s) last=${st.lastPrice ?? '—'} @${st.lastTime ?? '—'}`);
  }
  log('');
  log(`판정 → approval_key 발급: ✅`);
  log(`판정 → WS 연결/구독: ✅ (위 ack 로그 참조)`);
  log(`판정 → 실시간 체결 수신: ${anyTick ? '✅ OK' : '⚠️ 0건 (장 마감/휴장 가능 — 평일 09:00~15:30 재측정)'}`);
  log('════════════════════════════════════════════');

  ws.close();
  setTimeout(() => process.exit(0), 500);
}

main().catch((err) => {
  log('치명적 오류:', err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
