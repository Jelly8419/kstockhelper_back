/**
 * Price Gap Monitor — USDT/KRW 시세 폴러 (업비트→빗썸 폴백).
 *
 * 갭의 분모로 "한국 시장에서 통용되는 USDT의 원화가"(USDT/KRW)를 쓴다.
 *   USD Reference = KR price / (USDT/KRW)
 *
 * 왜 은행 USD/KRW가 아니라 USDT/KRW인가:
 *   - Binance/Bybit perp 가격이 USDT 기준(SAMSUNGUSDT)이라, 분모도 USDT 단위여야
 *     perp와 같은 단위로 비교된다(USDT≠USD 디페그 노이즈 제거, 김치프리미엄 상쇄).
 *   - 업비트/빗썸 public market API는 외부 이용을 전제로 제공되어 비공식 웹
 *     엔드포인트(은행 고시환율 스크래이핑)보다 라이선스 리스크가 낮다.
 *
 *   1차: 업비트 KRW-USDT  — 거래량 풍부, 초단위 신선도
 *   2차: 빗썸 USDT_KRW    — 폴백
 *
 * 둘 다 한국 거래소라 해외 배포 리전에서도 접근 가능(공개 시세). 셋 다 실패하면
 * 갱신을 건너뛰고 store의 마지막 값이 stale로 처리된다.
 *
 * 수집기 책임: USDT/KRW 최신값을 store.updateFx()로 밀어넣기만 한다.
 */
import axios from 'axios';
import { updateFx } from './store';
import { env } from '../config/env';
import { logger } from '../utils/logger';

const UPBIT_URL = 'https://api.upbit.com/v1/ticker?markets=KRW-USDT';
const BITHUMB_URL = 'https://api.bithumb.com/public/ticker/USDT_KRW';

/** 1차: 업비트 KRW-USDT. result[0].trade_price (number, 원). */
async function fromUpbit(): Promise<number | null> {
  const { data } = await axios.get(UPBIT_URL, { timeout: 8_000 });
  const price = Array.isArray(data) ? data[0]?.trade_price : undefined;
  return typeof price === 'number' && Number.isFinite(price) && price > 0 ? price : null;
}

/** 2차: 빗썸 USDT_KRW. data.closing_price (문자열, 원). */
async function fromBithumb(): Promise<number | null> {
  const { data } = await axios.get(BITHUMB_URL, { timeout: 8_000 });
  if (data?.status !== '0000') return null;
  const n = Number(data?.data?.closing_price);
  return Number.isFinite(n) && n > 0 ? n : null;
}

const SOURCES: { name: string; fn: () => Promise<number | null> }[] = [
  { name: 'Upbit', fn: fromUpbit },
  { name: 'Bithumb', fn: fromBithumb },
];

/** 한 주기: 소스를 순서대로 시도해 첫 성공값을 store에 반영. */
async function pollOnce(): Promise<void> {
  for (const src of SOURCES) {
    try {
      const price = await src.fn();
      if (price !== null) {
        updateFx(price);
        return;
      }
      logger.warn(`[FX] ${src.name} 응답 파싱 실패 — 다음 소스 폴백`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[FX] ${src.name} 호출 실패 (${msg}) — 다음 소스 폴백`);
    }
  }
  // 전 소스 실패 — 갱신 생략. store의 마지막 값이 stale 처리된다.
  logger.error('[FX] 전 소스 실패 — USDT/KRW 갱신 생략(마지막 값 stale)');
}

let timer: NodeJS.Timeout | null = null;

/** USDT/KRW 폴링 시작 — 즉시 1회 + fxPollMs 주기. */
export function startFxFeed(): void {
  if (timer) return; // 중복 기동 방지
  void pollOnce();
  timer = setInterval(() => void pollOnce(), env.fxPollMs);
  logger.info(`[FX] 폴링 시작 (${env.fxPollMs / 1000}s 주기, Upbit→Bithumb USDT/KRW)`);
}

/** USDT/KRW 폴링 중지 */
export function stopFxFeed(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
