/**
 * PayPal Subscriptions Plan 생성 스크립트 (1회 실행, 결과 PAYPAL_PLAN_ID를 .env에 기록).
 *
 * 생성 구조 (요청서 §4):
 *   Product (K-Stock Helper Premium)
 *   └ Plan
 *      ├ Trial cycle:   $1.00 / 1 month  (첫 달, 1회)
 *      └ Regular cycle: $4.90 / month    (이후 매월 자동, 무기한)
 *
 * 실행:
 *   PAYPAL_MODE=sandbox npx tsx scripts/createPaypalPlan.ts
 *   PAYPAL_MODE=live    npx tsx scripts/createPaypalPlan.ts
 *
 * 필요한 env: PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_MODE(sandbox|live).
 * 출력된 plan id를 .env의 PAYPAL_PLAN_ID에 넣는다. sandbox/live는 별도 plan을 만들어야 한다.
 */

import dotenv from 'dotenv';

dotenv.config();

const MODE = process.env.PAYPAL_MODE === 'live' ? 'live' : 'sandbox';
const BASE_URL =
  MODE === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
const CLIENT_ID = process.env.PAYPAL_CLIENT_ID || '';
const CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET || '';

function die(msg: string): never {
  console.error(`\n❌ ${msg}`);
  process.exit(1);
}

if (!CLIENT_ID || !CLIENT_SECRET) {
  die('PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET 가 .env에 필요합니다.');
}

async function token(): Promise<string> {
  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const res = await fetch(`${BASE_URL}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) die(`OAuth 실패 (${res.status}): ${await res.text()}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

async function post(path: string, accessToken: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) die(`${path} 실패 (${res.status}): ${text}`);
  return JSON.parse(text) as Record<string, unknown>;
}

async function main(): Promise<void> {
  console.log(`PayPal Plan 생성 시작 — mode=${MODE}`);
  const accessToken = await token();

  // 1) Product 생성
  const product = await post('/v1/catalogs/products', accessToken, {
    name: 'K-Stock Helper Premium',
    description: 'K-Stock Helper Premium subscription (restricted region).',
    type: 'SERVICE',
    category: 'SOFTWARE',
  });
  const productId = product.id as string;
  console.log(`✅ Product 생성: ${productId}`);

  // 2) Plan 생성 (Trial + Regular)
  const plan = await post('/v1/billing/plans', accessToken, {
    product_id: productId,
    name: 'K-Stock Helper Premium Monthly',
    description: '$1 first month, then $4.90/month.',
    status: 'ACTIVE',
    billing_cycles: [
      {
        frequency: { interval_unit: 'MONTH', interval_count: 1 },
        tenure_type: 'TRIAL',
        sequence: 1,
        total_cycles: 1, // 첫 달 1회
        pricing_scheme: { fixed_price: { value: '1.00', currency_code: 'USD' } },
      },
      {
        frequency: { interval_unit: 'MONTH', interval_count: 1 },
        tenure_type: 'REGULAR',
        sequence: 2,
        total_cycles: 0, // 무기한 매월
        pricing_scheme: { fixed_price: { value: '4.90', currency_code: 'USD' } },
      },
    ],
    payment_preferences: {
      auto_bill_outstanding: true,
      setup_fee_failure_action: 'CANCEL',
      // 갱신 결제 1회 실패 시 즉시 실패 처리(요구사항: 유예 없음). Webhook로 즉시 Basic 전환.
      payment_failure_threshold: 0,
    },
  });
  const planId = plan.id as string;

  console.log(`\n✅ Plan 생성 완료`);
  console.log(`\n  PAYPAL_PLAN_ID=${planId}\n`);
  console.log(`위 값을 .env(${MODE})의 PAYPAL_PLAN_ID에 기록하세요.`);
}

main().catch((err) => die(err instanceof Error ? err.message : String(err)));
