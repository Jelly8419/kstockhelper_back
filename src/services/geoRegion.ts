// 지역 재검증 — PayPal 구독은 "제한국가"에서만 허용한다.
// 프론트의 제한국가 판별 쿠키(x-restricted-region)는 non-httpOnly라 변조 가능하므로,
// 구독 생성/Premium 부여는 백엔드가 요청 IP의 country로 다시 검증한다(요청서 §5).
//
// 정책은 프론트 lib/geo/bannerGate.ts 와 1:1로 일치시킨다:
//  - BLOCKED_COUNTRIES(17개국)가 "제한국가"(=구독 대상).
//  - 단 KR은 화이트리스트 IP면 허용국가로 취급(개발자/PM 프리뷰) → 구독 거부.
//  - country 판별 실패(unknown)는 안전하게 "제한국가"로 처리(요청서 §2 권장 기본값,
//    프론트 isRestrictedForSubscription의 production 기본값과 동일).
//
// 백엔드는 Railway 리버스 프록시 뒤라 Vercel geo 헤더가 없다. 따라서 x-forwarded-for의
// 클라이언트 IP를 geoip-lite(오프라인 DB)로 country 변환한다.

import geoip from 'geoip-lite';
import type { Request } from 'express';

/**
 * 거래소 레퍼럴/UID 연동이 차단된 국가 = PayPal 구독 대상 "제한국가".
 * 프론트 bannerGate.ts BLOCKED_COUNTRIES와 동일하게 유지할 것.
 */
const BLOCKED_COUNTRIES = new Set<string>([
  'KR',
  'US',
  'CA',
  'CN',
  'HK',
  'SG',
  'KP',
  'IR',
  'SY',
  'CU',
  'JP',
  'GB',
  'NL',
  'IL',
  'NG',
  'TR',
  'UZ',
]);

/** KR이지만 허용국가로 취급하는 내부 IP(개발자/PM). 프론트와 동일하게 유지. */
const KR_WHITELIST_IPS = new Set<string>([
  '220.65.243.225', // developer
]);

/** KR 화이트리스트 CIDR(동적 IP 대역). 프론트와 동일하게 유지. */
const KR_WHITELIST_CIDRS: string[] = [
  '115.138.0.0/16', // PM (dynamic IP)
];

/** 점-구분 IPv4 문자열을 32비트 부호없는 정수로 변환. 실패 시 null. */
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;

  let result = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    result = result * 256 + octet;
  }
  return result >>> 0;
}

/** IPv4가 CIDR 범위(예: 1.2.0.0/16)에 속하는지 검사. */
function ipInCidr(ip: string, cidr: string): boolean {
  const [range, bitsStr] = cidr.split('/');
  const bits = Number(bitsStr);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;

  const ipInt = ipv4ToInt(ip);
  const rangeInt = ipv4ToInt(range);
  if (ipInt === null || rangeInt === null) return false;

  // /0은 전체 매치. <<32의 미정의 동작을 피한다.
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipInt & mask) === (rangeInt & mask);
}

/** IP가 KR 화이트리스트(정확 일치 Set 또는 CIDR)에 속하는지. */
function isWhitelistedKrIp(ip: string): boolean {
  if (KR_WHITELIST_IPS.has(ip)) return true;
  return KR_WHITELIST_CIDRS.some((cidr) => ipInCidr(ip, cidr));
}

/**
 * 요청의 첫 번째 클라이언트 IP를 뽑는다.
 * Express는 trust proxy(app.set('trust proxy', 1)) 설정이라 req.ip가 x-forwarded-for의
 * 클라이언트 IP를 반영한다. 안전하게 x-forwarded-for를 우선 파싱하고 req.ip로 폴백한다.
 * IPv6-mapped IPv4(::ffff:1.2.3.4)는 IPv4 부분만 남긴다.
 */
export function requestIp(req: Request): string {
  const fwd = req.headers['x-forwarded-for'];
  const raw =
    (typeof fwd === 'string' ? fwd.split(',')[0] : Array.isArray(fwd) ? fwd[0] : undefined) ??
    req.ip ??
    '';
  const ip = raw.trim();
  return ip.startsWith('::ffff:') ? ip.slice('::ffff:'.length) : ip;
}

/** IP → ISO alpha-2 country code (대문자). 판별 실패 시 null. */
export function lookupCountry(ip: string): string | null {
  if (!ip) return null;
  const geo = geoip.lookup(ip);
  return geo?.country ? geo.country.toUpperCase() : null;
}

export interface RegionDecision {
  /** 구독 허용 여부(= 제한국가 그룹). */
  restrictedForSubscription: boolean;
  /** 판별된 country (null이면 판별 실패). */
  country: string | null;
  /** 사용한 클라이언트 IP. */
  ip: string;
}

/**
 * 구독 정책상 "제한국가"인지 판정한다(= PayPal 구독 허용 대상).
 * 프론트 isRestrictedForSubscription과 동일한 결론을 내도록 설계:
 *  - blocklist 국가 → 제한국가(단, KR 화이트리스트 IP는 제외).
 *  - country 판별 실패(unknown) → 제한국가(안전 기본값).
 *  - 그 외(허용국가) → 비제한 → 구독 거부.
 */
export function decideRegion(req: Request): RegionDecision {
  const ip = requestIp(req);
  const country = lookupCountry(ip);

  // 판별 실패: 안전하게 제한국가로 처리.
  if (!country) {
    return { restrictedForSubscription: true, country: null, ip };
  }

  // 허용국가: 구독 거부.
  if (!BLOCKED_COUNTRIES.has(country)) {
    return { restrictedForSubscription: false, country, ip };
  }

  // blocklist 국가지만 KR 화이트리스트 IP면 허용국가로 취급 → 구독 거부.
  if (country === 'KR' && isWhitelistedKrIp(ip)) {
    return { restrictedForSubscription: false, country, ip };
  }

  // 제한국가 → 구독 허용.
  return { restrictedForSubscription: true, country, ip };
}
