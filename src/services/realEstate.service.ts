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
  REAL_ESTATE_STATUSES,
  type RealEstateRequestInput,
  type RealEstateRequestRow,
  type RealEstateRequestListItem,
  type RealEstateRequestDetail,
  type RealEstateStatus,
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

// ── 어드미 관리 (PRD: Admin - 부동산 구매 요청 관리) ──────────────────────────
// 모두 service_role(RLS 우회)로 동작. /internal/admin 라우터(internalGuard) 뒤에서만 호출된다.

/** 어드미 관리자 메모 최대 길이. users admin_memo(ADMIN_MEMO_MAX=1000)와 동일하게 둔다. */
export const REAL_ESTATE_MEMO_MAX = 1000;

const LIST_SELECT = 'id, created_at, country_of_residence, email, currently_in_korea, status';
const DETAIL_SELECT =
  'id, created_at, email, country_of_residence, budget_currency, budget_min, budget_max, ' +
  'property_type, currently_in_korea, message, status, admin_memo, user_id, locale, country_code';

/** status 문자열을 RealEstateStatus로 정규화(비표준값은 RECEIVED). */
function normalizeStatus(s: unknown): RealEstateStatus {
  return s === 'ANSWERED' ? 'ANSWERED' : 'RECEIVED';
}

/** 어드미 리스트 — 요청일 최신순(PRD 5). */
export async function listRequests(): Promise<RealEstateRequestListItem[]> {
  const { data, error } = await supabase
    .from('real_estate_requests')
    .select(LIST_SELECT)
    .order('created_at', { ascending: false });

  if (error) {
    logger.error('real_estate_requests 리스트 조회 실패:', error.message);
    throw error;
  }

  return (data ?? []).map((r: Record<string, unknown>) => ({
    id: String(r.id),
    createdAt: String(r.created_at),
    countryOfResidence: String(r.country_of_residence ?? ''),
    email: String(r.email ?? ''),
    currentlyInKorea: Boolean(r.currently_in_korea),
    status: normalizeStatus(r.status),
  }));
}

/** 어드미 상세 — 전체 입력값 + 메모(PRD 7.2). 미존재 시 null. */
export async function getRequestDetail(id: string): Promise<RealEstateRequestDetail | null> {
  const { data, error } = await supabase
    .from('real_estate_requests')
    .select(DETAIL_SELECT)
    .eq('id', id)
    .limit(1);

  if (error) {
    logger.error('real_estate_requests 상세 조회 실패:', error.message);
    throw error;
  }

  const r = data?.[0] as unknown as Record<string, unknown> | undefined;
  if (!r) return null;

  return {
    id: String(r.id),
    createdAt: String(r.created_at),
    email: String(r.email ?? ''),
    countryOfResidence: String(r.country_of_residence ?? ''),
    budgetCurrency: String(r.budget_currency ?? ''),
    budgetMin: Number(r.budget_min ?? 0),
    budgetMax: Number(r.budget_max ?? 0),
    propertyType: String(r.property_type ?? ''),
    currentlyInKorea: Boolean(r.currently_in_korea),
    message: String(r.message ?? ''),
    status: normalizeStatus(r.status),
    adminMemo: r.admin_memo == null ? null : String(r.admin_memo),
    userId: r.user_id == null ? null : String(r.user_id),
    locale: r.locale == null ? null : String(r.locale),
    countryCode: r.country_code == null ? null : String(r.country_code),
  };
}

export type AdminUpdateResult = { ok: true } | { ok: false; reason: 'not_found' };

/** status 값이 허용 집합(RECEIVED/ANSWERED)인지. */
export function isValidStatus(s: unknown): s is RealEstateStatus {
  return typeof s === 'string' && (REAL_ESTATE_STATUSES as readonly string[]).includes(s);
}

/** 상태 변경(PRD 8.1). 미존재 시 not_found. */
export async function changeStatus(
  id: string,
  status: RealEstateStatus,
): Promise<AdminUpdateResult> {
  const { data, error } = await supabase
    .from('real_estate_requests')
    .update({ status })
    .eq('id', id)
    .select('id');

  if (error) {
    logger.error('real_estate_requests 상태 변경 실패:', error.message);
    throw error;
  }
  if (!data || data.length === 0) return { ok: false, reason: 'not_found' };
  return { ok: true };
}

/** 관리자 메모 저장(PRD 8.2, 단일 필드 덮어쓰기). 미존재 시 not_found. */
export async function saveAdminMemo(id: string, memo: string): Promise<AdminUpdateResult> {
  const { data, error } = await supabase
    .from('real_estate_requests')
    .update({ admin_memo: memo })
    .eq('id', id)
    .select('id');

  if (error) {
    logger.error('real_estate_requests 메모 저장 실패:', error.message);
    throw error;
  }
  if (!data || data.length === 0) return { ok: false, reason: 'not_found' };
  return { ok: true };
}
