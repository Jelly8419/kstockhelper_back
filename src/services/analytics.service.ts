// 애널리틱스 통계 — 콘솔 이벤트 통계 API용 (events 요청서 §3).
// 0007_events.sql(프론트 레포)의 분석 뷰 3종을 service_role로 그대로 select 한다.
//   analytics_dau / analytics_funnel_daily / analytics_event_counts
// 뷰는 RLS SELECT 차단을 definer 권한으로 우회하므로 service_role이면 읽힌다.
//
// 타임존: 뷰의 day = date_trunc('day', created_at)는 UTC 기준. 그대로 내려주고
//         KST 일자 변환은 프론트가 담당한다(회신서 명시).

import { supabase } from '../config/supabase';
import { logger } from '../utils/logger';
import type {
  AnalyticsDauRow,
  AnalyticsFunnelRow,
  AnalyticsFunnelTotal,
  AnalyticsEventCountRow,
  AnalyticsRawRow,
  AnalyticsRawResponse,
} from '../types';

/** 날짜 범위 옵션. 미지정 시 호출부에서 최근 30일로 기본 적용. */
export interface DateRange {
  from?: string; // 'YYYY-MM-DD' (포함)
  to?: string; // 'YYYY-MM-DD' (해당 일자 끝까지 포함)
}

const DEFAULT_RANGE_DAYS = 30; // 집계 API 기본 범위
const DEFAULT_RAW_RANGE_DAYS = 7; // raw 조회는 데이터가 많아 좁게(요청서 §4)

// raw 페이지네이션(요청서 §2)
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

/** 'YYYY-MM-DD' 형식 여부(느슨한 검증). 형식 불일치 값은 무시한다. */
function isYmd(v: string | undefined): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

/**
 * day(timestamptz) 컬럼에 적용할 [gte, lt) 경계를 ISO로 만든다.
 * - from: 해당 날짜 00:00 UTC 이상
 * - to:   해당 날짜 +1일 00:00 UTC 미만 (그 날 23:59:59까지 포함)
 * 둘 다 미지정이면 from은 오늘-30일, to는 없음(현재까지).
 */
function resolveBounds(
  range: DateRange,
  defaultDays = DEFAULT_RANGE_DAYS,
): { gte: string; lt?: string } {
  const from = isYmd(range.from) ? range.from : undefined;
  const to = isYmd(range.to) ? range.to : undefined;

  let gteDate: string;
  if (from) {
    gteDate = from;
  } else {
    // 기본: 최근 defaultDays일. Date.now() 사용 불가 환경 대비 없이 서버 런타임 시각 사용.
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - defaultDays);
    gteDate = d.toISOString().slice(0, 10);
  }

  const bounds: { gte: string; lt?: string } = { gte: `${gteDate}T00:00:00.000Z` };

  if (to) {
    const t = new Date(`${to}T00:00:00.000Z`);
    t.setUTCDate(t.getUTCDate() + 1); // 끝일 포함 → 다음날 00:00 미만
    bounds.lt = t.toISOString();
  }
  return bounds;
}

/** day 범위 필터를 쿼리에 적용. (뷰는 created_at이 없고 day만 있으므로 day로 거른다.) */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyRange(query: any, range: DateRange) {
  const { gte, lt } = resolveBounds(range);
  let q = query.gte('day', gte);
  if (lt) q = q.lt('day', lt);
  return q;
}

/** 일별 활성 유저 / 이벤트량 (analytics_dau). */
export async function getDau(range: DateRange): Promise<AnalyticsDauRow[]> {
  const { data, error } = await applyRange(
    supabase.from('analytics_dau').select('day, unique_visitors, logged_in_users, total_events'),
    range,
  ).order('day', { ascending: false });

  if (error) {
    logger.error('analytics_dau 조회 실패:', error.message);
    throw error;
  }

  return (data ?? []).map((r: Record<string, unknown>) => ({
    day: String(r.day),
    uniqueVisitors: Number(r.unique_visitors ?? 0),
    loggedInUsers: Number(r.logged_in_users ?? 0),
    totalEvents: Number(r.total_events ?? 0),
  }));
}

const FUNNEL_COLS =
  'day, visited, signed_up, gap_viewed, premium_blocked, sub_page_viewed, subscribe_clicked, activated';

function mapFunnelRow(r: Record<string, unknown>): AnalyticsFunnelRow {
  return {
    day: String(r.day),
    visited: Number(r.visited ?? 0),
    signedUp: Number(r.signed_up ?? 0),
    gapViewed: Number(r.gap_viewed ?? 0),
    premiumBlocked: Number(r.premium_blocked ?? 0),
    subPageViewed: Number(r.sub_page_viewed ?? 0),
    subscribeClicked: Number(r.subscribe_clicked ?? 0),
    activated: Number(r.activated ?? 0),
  };
}

/** 전환 퍼널 (일별, analytics_funnel_daily). */
export async function getFunnelDaily(range: DateRange): Promise<AnalyticsFunnelRow[]> {
  const { data, error } = await applyRange(
    supabase.from('analytics_funnel_daily').select(FUNNEL_COLS),
    range,
  ).order('day', { ascending: false });

  if (error) {
    logger.error('analytics_funnel_daily 조회 실패:', error.message);
    throw error;
  }

  return (data ?? []).map((r: Record<string, unknown>) => mapFunnelRow(r));
}

/** 전환 퍼널 합계 (mode=total). 일별 행을 단계별로 합산. */
export async function getFunnelTotal(range: DateRange): Promise<AnalyticsFunnelTotal> {
  const rows = await getFunnelDaily(range);
  return rows.reduce<AnalyticsFunnelTotal>(
    (acc, r) => ({
      visited: acc.visited + r.visited,
      signedUp: acc.signedUp + r.signedUp,
      gapViewed: acc.gapViewed + r.gapViewed,
      premiumBlocked: acc.premiumBlocked + r.premiumBlocked,
      subPageViewed: acc.subPageViewed + r.subPageViewed,
      subscribeClicked: acc.subscribeClicked + r.subscribeClicked,
      activated: acc.activated + r.activated,
    }),
    {
      visited: 0,
      signedUp: 0,
      gapViewed: 0,
      premiumBlocked: 0,
      subPageViewed: 0,
      subscribeClicked: 0,
      activated: 0,
    },
  );
}

/** 이벤트별 일 카운트 (analytics_event_counts). eventName 지정 시 해당 이벤트만. */
export async function getEventCounts(
  range: DateRange,
  eventName?: string,
): Promise<AnalyticsEventCountRow[]> {
  let query = supabase.from('analytics_event_counts').select('day, event_name, cnt');
  query = applyRange(query, range);
  if (eventName && eventName.trim()) {
    query = query.eq('event_name', eventName.trim());
  }

  const { data, error } = await query
    .order('day', { ascending: false })
    .order('cnt', { ascending: false });

  if (error) {
    logger.error('analytics_event_counts 조회 실패:', error.message);
    throw error;
  }

  return (data ?? []).map((r: Record<string, unknown>) => ({
    day: String(r.day),
    eventName: String(r.event_name),
    count: Number(r.cnt ?? 0),
  }));
}

export interface RawQuery extends DateRange {
  eventNames?: string[]; // 영역 탭 필터(요청서 §3). 비면 전체.
  page?: number; // 0-base
  pageSize?: number;
}

const RAW_COLS =
  'created_at, event_name, user_id, country_code, country_group, membership_status, page_path, device_type, properties';

/**
 * events 원본 행을 최신순으로 필터·페이지네이션해 반환한다(요청서 §2, RAW 조회).
 * - 기간 미지정 시 최근 7일(raw는 데이터가 많아 좁게).
 * - total은 정확한 count(count:'exact') — 페이지네이션 UI용.
 * - properties는 jsonb 통째로(프론트가 영역별 키 추출).
 */
export async function getRawEvents(input: RawQuery): Promise<AnalyticsRawResponse> {
  const page = Number.isInteger(input.page) && input.page! >= 0 ? input.page! : 0;
  const rawSize = Number.isFinite(input.pageSize) ? Number(input.pageSize) : DEFAULT_PAGE_SIZE;
  const pageSize = Math.min(Math.max(1, rawSize), MAX_PAGE_SIZE);

  const { gte, lt } = resolveBounds(input, DEFAULT_RAW_RANGE_DAYS);

  let query = supabase
    .from('events')
    .select(RAW_COLS, { count: 'exact' })
    .gte('created_at', gte);
  if (lt) query = query.lt('created_at', lt);

  const names = (input.eventNames ?? []).map((n) => n.trim()).filter(Boolean);
  if (names.length > 0) query = query.in('event_name', names);

  const fromIdx = page * pageSize;
  const toIdx = fromIdx + pageSize - 1;
  const { data, error, count } = await query
    .order('created_at', { ascending: false })
    .range(fromIdx, toIdx);

  if (error) {
    logger.error('events raw 조회 실패:', error.message);
    throw error;
  }

  const rows: AnalyticsRawRow[] = (data ?? []).map((r: Record<string, unknown>) => ({
    createdAt: String(r.created_at),
    eventName: String(r.event_name),
    userId: (r.user_id as string | null) ?? null,
    countryCode: (r.country_code as string | null) ?? null,
    countryGroup: (r.country_group as string | null) ?? null,
    membershipStatus: (r.membership_status as string | null) ?? null,
    pagePath: (r.page_path as string | null) ?? null,
    deviceType: (r.device_type as string | null) ?? null,
    properties: (r.properties as Record<string, unknown>) ?? {},
  }));

  return { rows, total: count ?? 0, page, pageSize };
}
