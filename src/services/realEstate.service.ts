// 부동산 구매 지원 요청 폼(리드 수집) — 서버 재검증 + service_role insert.
// (회신서: 백엔드회신·프론트회신_부동산_구매지원요청폼.md)
//
// 호출 경로: 브라우저 → 프론트 BFF(얇은 프록시) → POST /api/real-estate/requests → 이 서비스.
// 프론트가 1차 검증을 하더라도 서버에서 다시 검증한다(클라 입력 신뢰 안 함).
// insert는 service_role 클라이언트(RLS 우회)로만 수행한다 — 테이블은 닫혀 있다(0014).

import { supabase } from '../config/supabase';
import { logger } from '../utils/logger';
import {
  REAL_ESTATE_CURRENCIES,
  REAL_ESTATE_PROPERTY_TYPES,
  type RealEstateRequestInput,
  type RealEstateRequestRow,
} from '../types';

const MAX_MESSAGE_LEN = 500;
const MAX_EMAIL_LEN = 320; // RFC 5321 local(64)+@+domain(255)
const MAX_TEXT_LEN = 200; // country_of_residence 등 일반 텍스트 상한

/** 느슨한 이메일 형식 검증(서버측 1차 방어선). 프론트가 더 엄격히 본다. */
function isValidEmail(v: string): boolean {
  // 공백 없는 local@domain.tld 최소 형태만 확인.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && v.length <= MAX_EMAIL_LEN;
}

/** 검증 결과 — ok면 정규화 row, 아니면 사유. */
export type ValidationResult =
  | { ok: true; row: RealEstateRequestRow }
  | { ok: false; reason: string };

/**
 * 폼 입력을 서버에서 재검증하고 insert용 row로 정규화한다.
 * - 모든 필수 텍스트는 trim 후 공백만이면 거부.
 * - 통화/유형은 화이트리스트(DB CHECK와 동일).
 * - budget은 유한 숫자 + 0 이상 + min ≤ max.
 * - userId/locale/countryCode는 BFF가 채운 부가값(없으면 null).
 */
export function validateAndNormalize(input: RealEstateRequestInput): ValidationResult {
  const email = String(input.email ?? '').trim();
  if (!email || !isValidEmail(email)) {
    return { ok: false, reason: 'invalid_email' };
  }

  const country = String(input.countryOfResidence ?? '').trim();
  if (!country || country.length > MAX_TEXT_LEN) {
    return { ok: false, reason: 'invalid_country_of_residence' };
  }

  const currency = String(input.budgetCurrency ?? '').trim().toUpperCase();
  if (!(REAL_ESTATE_CURRENCIES as readonly string[]).includes(currency)) {
    return { ok: false, reason: 'invalid_budget_currency' };
  }

  const min = Number(input.budgetMin);
  const max = Number(input.budgetMax);
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return { ok: false, reason: 'invalid_budget_number' };
  }
  if (min < 0 || max < 0) {
    return { ok: false, reason: 'invalid_budget_negative' };
  }
  if (min > max) {
    return { ok: false, reason: 'invalid_budget_range' };
  }

  const propertyType = String(input.propertyType ?? '').trim();
  if (!(REAL_ESTATE_PROPERTY_TYPES as readonly string[]).includes(propertyType)) {
    return { ok: false, reason: 'invalid_property_type' };
  }

  if (typeof input.currentlyInKorea !== 'boolean') {
    return { ok: false, reason: 'invalid_currently_in_korea' };
  }

  const message = String(input.message ?? '').trim();
  if (!message) {
    return { ok: false, reason: 'invalid_message_empty' };
  }
  if (message.length > MAX_MESSAGE_LEN) {
    return { ok: false, reason: 'invalid_message_too_long' };
  }

  // 부가값 — BFF가 서버 신뢰값으로 채운다. 형식만 가볍게 본다.
  const userId =
    typeof input.userId === 'string' && input.userId.trim() ? input.userId.trim() : null;
  const locale =
    typeof input.locale === 'string' && input.locale.trim()
      ? input.locale.trim().slice(0, 35)
      : null;
  const countryCode =
    typeof input.countryCode === 'string' && input.countryCode.trim()
      ? input.countryCode.trim().toUpperCase().slice(0, 2)
      : null;

  return {
    ok: true,
    row: {
      email,
      country_of_residence: country,
      budget_currency: currency,
      budget_min: min,
      budget_max: max,
      property_type: propertyType,
      currently_in_korea: input.currentlyInKorea,
      message,
      user_id: userId,
      locale,
      country_code: countryCode,
    },
  };
}

/**
 * 정규화된 row를 real_estate_requests에 insert한다(service_role).
 * 성공 시 생성된 id를 반환. 실패 시 throw(라우트가 500 envelope로 변환).
 */
export async function insertRealEstateRequest(row: RealEstateRequestRow): Promise<string> {
  const { data, error } = await supabase
    .from('real_estate_requests')
    .insert(row)
    .select('id')
    .single();

  if (error) {
    logger.error('real_estate_requests insert 실패:', error.message);
    throw error;
  }
  return String(data.id);
}
