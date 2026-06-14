/**
 * Price Gap Monitor — KIS WebSocket 수집기 (국내주식 실시간체결가 H0STCNT0).
 *
 * scripts/probeKisWs.ts(PoC 검증됨)를 운영화한 것. 책임:
 *   - approval_key 발급 → WS 연결 → 3종목 구독 → 체결가를 store.updateKrPrice()로 전달
 *   - PINGPONG echo로 연결 유지, 끊기면 지수백오프 재연결(키 재발급)
 *
 * stale 판정은 store가 마지막 ts로 처리하므로 여기선 신경 쓰지 않는다.
 *
 * 응답 형식: "0|H0STCNT0|<건수>|<필드^필드^...>"
 *   - 파이프(|)로 헤더 분리, parts[3]가 본문. 본문은 캐럿(^)으로 필드 구분.
 *   - 한 프레임에 여러 체결이면 6필드 단위 반복 → 마지막(최신) 건을 반영.
 *   - index 2 = STCK_PRPR(체결가).
 */
import WebSocket from 'ws';
import { getKisApprovalKey } from '../config/kisApproval';
import { updateKrPrice } from './store';
import { GAP_STOCK_CODES } from './symbols';
import { toNum } from '../collectors/publicCommon';
import { logger } from '../utils/logger';

const KIS_WS_URL = 'ws://ops.koreainvestment.com:21000';
const TR_ID = 'H0STCNT0';
/** H0STCNT0 응답 한 건의 필드 수 (다건 프레임 분해용) */
const FIELDS_PER_TICK = 46;
/** STCK_PRPR(체결가) 인덱스 */
const PRICE_IDX = 2;

const MAX_BACKOFF_MS = 30_000;

let ws: WebSocket | null = null;
let stopped = false;
let backoffMs = 1_000;
let reconnectTimer: NodeJS.Timeout | null = null;

function subscribeMsg(approvalKey: string, code: string): string {
  return JSON.stringify({
    header: {
      approval_key: approvalKey,
      custtype: 'P',
      tr_type: '1', // 1=등록
      'content-type': 'utf-8',
    },
    body: { input: { tr_id: TR_ID, tr_key: code } },
  });
}

/** 실시간 체결 데이터 파싱 → 마지막(최신) 건의 체결가를 store에 반영 */
function handleRealtime(raw: string): void {
  const parts = raw.split('|');
  if (parts.length < 4 || parts[1] !== TR_ID) return;

  const fields = parts[3].split('^');
  // 다건 프레임: 6필드 단위로 끝까지 순회하며 마지막 건을 채택(가장 최신).
  // 종목코드(index0)는 건마다 동일하므로 마지막 건 기준으로 처리.
  const lastBase = Math.floor((fields.length - 1) / FIELDS_PER_TICK) * FIELDS_PER_TICK;
  const code = fields[lastBase];
  const price = toNum(fields[lastBase + PRICE_IDX]);
  if (code && price !== null) {
    updateKrPrice(code, price);
  }
}

function scheduleReconnect(): void {
  if (stopped || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect(true);
  }, backoffMs);
  backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
}

async function connect(refreshKey = false): Promise<void> {
  if (stopped) return;
  let approvalKey: string;
  try {
    approvalKey = await getKisApprovalKey(refreshKey);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[KIS] approval_key 발급 실패 (${msg}) — 재시도 예약`);
    scheduleReconnect();
    return;
  }

  const sock = new WebSocket(KIS_WS_URL);
  ws = sock;

  sock.on('open', () => {
    backoffMs = 1_000; // 성공 연결 시 백오프 리셋
    for (const code of GAP_STOCK_CODES) {
      sock.send(subscribeMsg(approvalKey, code));
    }
    logger.info(`[KIS] WS 연결 + ${GAP_STOCK_CODES.length}종목 구독`);
  });

  sock.on('message', (buf: WebSocket.RawData) => {
    const raw = buf.toString();
    if (raw.startsWith('{')) {
      // JSON: 구독 ack 또는 PINGPONG
      try {
        const msg = JSON.parse(raw);
        if (msg.header?.tr_id === 'PINGPONG') {
          sock.send(raw); // echo로 연결 유지
        }
      } catch {
        /* 무시 */
      }
      return;
    }
    handleRealtime(raw);
  });

  sock.on('error', (err) => {
    logger.warn(`[KIS] WS 에러: ${err instanceof Error ? err.message : String(err)}`);
  });

  sock.on('close', (code) => {
    if (ws === sock) ws = null;
    if (!stopped) {
      logger.warn(`[KIS] WS 닫힘 (code=${code}) — 재연결 예약`);
      scheduleReconnect();
    }
  });
}

/** KIS WS 수집 시작 */
export function startKisFeed(): void {
  stopped = false;
  backoffMs = 1_000;
  void connect(false);
}

/** KIS WS 수집 중지 */
export function stopKisFeed(): void {
  stopped = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    ws.close();
    ws = null;
  }
}
