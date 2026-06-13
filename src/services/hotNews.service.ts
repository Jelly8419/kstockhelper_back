import { supabase } from '../config/supabase';
import { logger } from '../utils/logger';
import { buildSlug } from '../utils/slug';
import { generateNewsBrief } from '../pipeline/newsBrief';
import { pretranslateHotNews } from './translation.service';
import { isValidStockId } from '../constants/stocks';
import type {
  HotNewsCreateInput,
  HotNewsStatusPatch,
  HotNewsRowInsert,
  HotNewsListItem,
  HotNewsDetail,
  HotNewsStatus,
} from '../types';

/**
 * Korean's Hot News 서비스 (관리자 직접 등록 + 예약 게시, 프리미엄 전용).
 *
 * 핵심 동작:
 * - 등록(create): 관리자 한국어 원문 → generateNewsBrief(sonnet)로 영문 가공본 생성 →
 *   slug 파생 → INSERT → 5개 언어 선제 번역(pretranslateHotNews). status 무관하게 등록 시 가공·번역.
 * - 상태 전환(changeStatus): MVP는 내용 수정 불가, status(+scheduled_at)만 변경.
 *   published 전환 시 published_at을 처음 한 번 기록.
 * - 삭제(delete): hard delete (번역은 FK cascade로 함께 삭제).
 * - publishDueScheduled: cron이 due scheduled의 published_at 정합성을 보강(노출은 뷰가 이미 보장).
 *
 * 검증(validate*)은 라우트에서 선호출해 400 분기에 쓴다.
 */

/** 검증 실패 메시지 (PRD §8 예외 흐름). ok=true면 통과. */
export type ValidationResult = { ok: true } | { ok: false; message: string };

const MSG = {
  required: '필수 항목을 입력해 주세요.',
  scheduledAtRequired: '예약 게시 일시를 입력해 주세요.',
  scheduledAtPast: '현재 시간 이후의 예약 게시 일시를 선택해 주세요.',
  invalidStock: '관련 종목 값이 올바르지 않습니다.',
  invalidStatus: '게시 상태 값이 올바르지 않습니다.',
} as const;

const VALID_STATUSES: readonly HotNewsStatus[] = ['scheduled', 'published', 'hidden'];

/** 문자열 비어있지 않음 */
function nonEmpty(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/** scheduled_at(ISO)이 현재 서버시각 이후인지. 파싱 불가면 false. */
function isFutureIso(iso: string): boolean {
  const t = Date.parse(iso);
  return !Number.isNaN(t) && t > Date.now();
}

/**
 * 등록 입력 검증 (PRD §8).
 * 필수값/종목/상태/예약일시 규칙을 순서대로 확인한다.
 */
export function validateCreateInput(input: HotNewsCreateInput): ValidationResult {
  if (!nonEmpty(input?.title) || !nonEmpty(input?.content)) {
    return { ok: false, message: MSG.required };
  }
  if (!Array.isArray(input.relatedStock) || input.relatedStock.length === 0) {
    return { ok: false, message: MSG.required };
  }
  if (!input.relatedStock.every((s) => typeof s === 'string' && isValidStockId(s))) {
    return { ok: false, message: MSG.invalidStock };
  }
  if (!VALID_STATUSES.includes(input.status)) {
    return { ok: false, message: MSG.invalidStatus };
  }
  return validateScheduling(input.status, input.scheduledAt);
}

/** 상태 전환 입력 검증 (PATCH). status + 예약일시 규칙만. */
export function validateStatusPatch(patch: HotNewsStatusPatch): ValidationResult {
  if (!VALID_STATUSES.includes(patch?.status)) {
    return { ok: false, message: MSG.invalidStatus };
  }
  return validateScheduling(patch.status, patch.scheduledAt);
}

/** scheduled일 때 예약일시 필수 + 미래 시각. 공용. */
function validateScheduling(status: HotNewsStatus, scheduledAt?: string | null): ValidationResult {
  if (status === 'scheduled') {
    if (!nonEmpty(scheduledAt)) {
      return { ok: false, message: MSG.scheduledAtRequired };
    }
    if (!isFutureIso(scheduledAt)) {
      return { ok: false, message: MSG.scheduledAtPast };
    }
  }
  return { ok: true };
}

/** 영문 가공본 (generateNewsBrief 산출 + slug) */
interface EnglishBrief {
  translated_title: string;
  summary: string;
  key_points: string[];
  slug: string | null;
}

/**
 * 한국어 원문을 영문 가공본으로 변환한다 (generateNewsBrief 재사용).
 * 자동 수집 뉴스와 동일 파이프라인 — translated_title/summary/key_points + slug.
 */
async function buildEnglishBrief(title: string, content: string): Promise<EnglishBrief> {
  const brief = await generateNewsBrief({ title, description: content });
  return {
    translated_title: brief.translated_title,
    summary: brief.summary,
    key_points: brief.key_points,
    slug: buildSlug(brief.translated_title),
  };
}

/** DB 행(snake_case) → 목록 DTO(camelCase) */
interface HotNewsRow {
  id: string;
  seq_id: number;
  title: string;
  content: string;
  stock_ids: string[] | null;
  status: HotNewsStatus;
  scheduled_at: string | null;
  published_at: string | null;
  created_at: string;
  updated_at: string;
}

function toListItem(row: HotNewsRow): HotNewsListItem {
  return {
    id: row.id,
    seqId: row.seq_id,
    title: row.title, // 관리자 목록은 한국어 원문 제목
    relatedStock: row.stock_ids ?? [],
    status: row.status,
    scheduledAt: row.scheduled_at,
    publishedAt: row.published_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const LIST_COLUMNS =
  'id, seq_id, title, stock_ids, status, scheduled_at, published_at, created_at, updated_at';

/**
 * 핫뉴스를 등록한다.
 * status 무관하게 등록 시 영문 가공 + 5개 언어 선제 번역한다.
 * 번역 실패는 등록을 막지 않는다(lazy 보강 없으므로 로그만 — cron/재등록으로 복구).
 *
 * @returns 생성된 hot_news.id
 */
export async function createHotNews(input: HotNewsCreateInput): Promise<string> {
  const brief = await buildEnglishBrief(input.title, input.content);

  const row: HotNewsRowInsert = {
    title: input.title,
    content: input.content,
    translated_title: brief.translated_title,
    summary: brief.summary,
    key_points: brief.key_points,
    slug: brief.slug,
    stock_ids: input.relatedStock,
    status: input.status,
    scheduled_at: input.status === 'scheduled' ? (input.scheduledAt ?? null) : null,
    published_at: input.status === 'published' ? new Date().toISOString() : null,
  };

  const { data, error } = await supabase.from('hot_news').insert([row]).select('id').single();
  if (error) {
    logger.error('핫뉴스 저장 실패:', error.message);
    throw error;
  }
  const id = String(data.id);

  // 선제 번역 (등록 시점). 실패해도 등록 성공 — 본문/노출은 영문 fallback으로 동작.
  try {
    await pretranslateHotNews(id);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`핫뉴스 선제 번역 실패 (id=${id}):`, msg);
  }

  logger.info(`핫뉴스 등록 — id=${id}, status=${input.status}`);
  return id;
}

/**
 * 핫뉴스 상태를 전환한다 (MVP: 내용 불변, status + scheduled_at만).
 * published로 전환 시 published_at이 비어있으면 now()를 기록한다.
 *
 * @returns ok=false면 not_found
 */
export async function changeHotNewsStatus(
  id: string,
  patch: HotNewsStatusPatch,
): Promise<{ ok: boolean }> {
  // 현재 행 조회 (존재 + published_at 보존 판단)
  const { data: existing, error: selErr } = await supabase
    .from('hot_news')
    .select('id, status, published_at')
    .eq('id', id)
    .maybeSingle();
  if (selErr) {
    logger.error(`핫뉴스 조회 실패 (id=${id}):`, selErr.message);
    throw selErr;
  }
  if (!existing) return { ok: false };

  const update: Record<string, unknown> = {
    status: patch.status,
    scheduled_at: patch.status === 'scheduled' ? (patch.scheduledAt ?? null) : null,
  };
  // published 최초 전환 시에만 published_at 기록 (이미 있으면 보존 — 최초 게시 시각 고정)
  if (patch.status === 'published' && !existing.published_at) {
    update.published_at = new Date().toISOString();
  }

  const { error: updErr } = await supabase.from('hot_news').update(update).eq('id', id);
  if (updErr) {
    logger.error(`핫뉴스 상태 변경 실패 (id=${id}):`, updErr.message);
    throw updErr;
  }
  logger.info(`핫뉴스 상태 변경 — id=${id}, status=${patch.status}`);
  return { ok: true };
}

/**
 * 핫뉴스를 실제 삭제한다 (hard delete). 번역은 FK cascade로 함께 삭제.
 * @returns ok=false면 not_found
 */
export async function deleteHotNews(id: string): Promise<{ ok: boolean }> {
  const { data, error } = await supabase.from('hot_news').delete().eq('id', id).select('id');
  if (error) {
    logger.error(`핫뉴스 삭제 실패 (id=${id}):`, error.message);
    throw error;
  }
  const deleted = (data?.length ?? 0) > 0;
  if (deleted) logger.info(`핫뉴스 삭제 — id=${id}`);
  return { ok: deleted };
}

/** 관리자 핫뉴스 목록 (전체 상태, 등록일 최신순). */
export async function listHotNews(): Promise<HotNewsListItem[]> {
  const { data, error } = await supabase
    .from('hot_news')
    .select(LIST_COLUMNS)
    .order('created_at', { ascending: false });
  if (error) {
    logger.error('핫뉴스 목록 조회 실패:', error.message);
    throw error;
  }
  return ((data ?? []) as HotNewsRow[]).map(toListItem);
}

/** 관리자 핫뉴스 단건 (편집용 — 한국어 원문 본문 포함). 없으면 null. */
export async function getHotNews(id: string): Promise<HotNewsDetail | null> {
  const { data, error } = await supabase
    .from('hot_news')
    .select(`${LIST_COLUMNS}, content`)
    .eq('id', id)
    .maybeSingle();
  if (error) {
    logger.error(`핫뉴스 단건 조회 실패 (id=${id}):`, error.message);
    throw error;
  }
  if (!data) return null;
  const row = data as HotNewsRow;
  return { ...toListItem(row), content: row.content };
}

/**
 * 예약 시간이 도달한 scheduled 핫뉴스의 published_at을 보강한다 (cron용).
 *
 * 노출 자체는 hot_news_public 뷰가 (scheduled AND scheduled_at<=now())로 이미 보장하므로,
 * 이 잡은 사용자에게 보이는 게시일(published_at)을 실제 도달 시각으로 채워 정합성을 맞추고,
 * Edge Case("예약 작업 실패 시 관리자가 Scheduled 상태 확인")와 무관하게 status는 유지한다.
 *
 * 정책: status는 'scheduled'로 둔 채 published_at만 채운다(뷰가 노출하므로 상태 전환 불필요).
 *       published_at이 채워진 due건은 다음 주기에 다시 잡히지 않는다(멱등).
 *
 * @returns published_at을 새로 기록한 건수
 */
export async function publishDueScheduled(): Promise<number> {
  const nowIso = new Date().toISOString();

  const { data, error } = await supabase
    .from('hot_news')
    .select('id')
    .eq('status', 'scheduled')
    .is('published_at', null)
    .lte('scheduled_at', nowIso);
  if (error) {
    logger.error('예약 핫뉴스 조회 실패:', error.message);
    throw error;
  }

  const due = (data ?? []) as { id: string }[];
  if (due.length === 0) return 0;

  let updated = 0;
  for (const { id } of due) {
    const { error: updErr } = await supabase
      .from('hot_news')
      .update({ published_at: nowIso })
      .eq('id', id)
      .is('published_at', null); // 동시성: 이미 채워졌으면 skip
    if (updErr) {
      logger.warn(`예약 핫뉴스 published_at 기록 실패 (id=${id}):`, updErr.message);
      continue;
    }
    updated++;
  }
  if (updated > 0) logger.info(`예약 핫뉴스 게시일 보강 — ${updated}건`);
  return updated;
}
