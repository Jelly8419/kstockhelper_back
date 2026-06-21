import { Router } from 'express';
import { adminAuth } from '../middleware/adminAuth';
import { adminLoginRateLimiter } from '../middleware/rateLimit';
import {
  verifyAdminCredentials,
  issueAdminToken,
  listUsers,
  getUserDetail,
  changeMembershipTier,
  saveMemo,
  ADMIN_MEMO_MAX,
  listPremiumApplications,
  processPremiumApplication,
} from '../services/admin.service';
import {
  validateCreateInput,
  validateStatusPatch,
  createHotNews,
  changeHotNewsStatus,
  deleteHotNews,
  listHotNews,
  getHotNews,
} from '../services/hotNews.service';
import { getAllFlags, setFlag, isKnownFlagKey } from '../services/featureFlags.service';
import {
  getDau,
  getFunnelDaily,
  getFunnelTotal,
  getEventCounts,
} from '../services/analytics.service';
import { logger } from '../utils/logger';
import type {
  AdminLoginResponse,
  AdminSimpleResponse,
  AdminUserListResponse,
  ApiTier,
  PremiumApplicationListResponse,
  ProcessApplicationResponse,
  HotNewsCreateInput,
  HotNewsStatusPatch,
  HotNewsListResponse,
  HotNewsCreateResponse,
  AnalyticsDauResponse,
  AnalyticsFunnelResponse,
  AnalyticsFunnelTotalResponse,
  AnalyticsEventCountResponse,
} from '../types';

/** 쿼리에서 from/to(YYYY-MM-DD) 추출. 문자열 아닌 값은 undefined로. */
function parseRange(query: Record<string, unknown>): { from?: string; to?: string } {
  const from = typeof query.from === 'string' ? query.from : undefined;
  const to = typeof query.to === 'string' ? query.to : undefined;
  return { from, to };
}

export const adminRouter = Router();

/**
 * POST /internal/admin/auth/login
 * 요청: { adminId: string, password: string }
 * 성공 시 { accessToken }. 일반 유저 인증과 분리된 자체 JWT.
 */
adminRouter.post('/auth/login', adminLoginRateLimiter, async (req, res) => {
  const { adminId, password } = req.body ?? {};

  if (typeof adminId !== 'string' || !adminId.trim() || typeof password !== 'string' || !password) {
    return res.status(400).json({
      success: false,
      message: '아이디 또는 비밀번호가 올바르지 않습니다.',
    } satisfies AdminSimpleResponse);
  }

  try {
    const admin = await verifyAdminCredentials(adminId.trim(), password);
    if (!admin) {
      return res.status(401).json({
        success: false,
        message: '아이디 또는 비밀번호가 올바르지 않습니다.',
      } satisfies AdminSimpleResponse);
    }

    const accessToken = issueAdminToken(admin);
    logger.info(`관리자 로그인 — adminId=${admin.admin_id}`);
    return res.status(200).json({ accessToken } satisfies AdminLoginResponse);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('관리자 로그인 처리 실패:', msg);
    return res.status(500).json({
      success: false,
      message: '로그인 처리 중 오류가 발생했습니다.',
    } satisfies AdminSimpleResponse);
  }
});

// ===== 이하 전부 관리자 인증 필요 =====
adminRouter.use(adminAuth);

/**
 * GET /internal/admin/users
 * 회원 리스트 (탈퇴 회원 포함, 가입일 최신순).
 */
adminRouter.get('/users', async (_req, res) => {
  try {
    const users = await listUsers();
    return res.status(200).json({ users } satisfies AdminUserListResponse);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('회원 리스트 조회 실패:', msg);
    return res.status(500).json({
      success: false,
      message: '회원 목록을 불러오지 못했습니다. 다시 시도해 주세요.',
    } satisfies AdminSimpleResponse);
  }
});

/**
 * GET /internal/admin/users/:userId
 * 회원 상세 (UID 상태, 통합 활동 로그, 관리자 메모 포함).
 */
adminRouter.get('/users/:userId', async (req, res) => {
  const { userId } = req.params;
  try {
    const detail = await getUserDetail(userId);
    if (!detail) {
      return res.status(404).json({
        success: false,
        message: '회원 정보를 불러오지 못했습니다. 다시 시도해 주세요.',
      } satisfies AdminSimpleResponse);
    }
    return res.status(200).json(detail);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('회원 상세 조회 실패:', msg);
    return res.status(500).json({
      success: false,
      message: '회원 정보를 불러오지 못했습니다. 다시 시도해 주세요.',
    } satisfies AdminSimpleResponse);
  }
});

/**
 * PATCH /internal/admin/users/:userId/membership-tier
 * 요청: { membershipTier: 'GENERAL' | 'PREMIUM' }
 * 회원등급 수동 변경. UID 상태는 변경하지 않는다.
 */
adminRouter.patch('/users/:userId/membership-tier', async (req, res) => {
  const { userId } = req.params;
  const { membershipTier } = req.body ?? {};

  if (membershipTier !== 'GENERAL' && membershipTier !== 'PREMIUM') {
    return res.status(400).json({
      success: false,
      message: 'membershipTier는 GENERAL 또는 PREMIUM이어야 합니다.',
    } satisfies AdminSimpleResponse);
  }

  try {
    const result = await changeMembershipTier(userId, membershipTier as ApiTier);
    if (!result.ok) {
      return res.status(404).json({
        success: false,
        message: '회원을 찾을 수 없습니다.',
      } satisfies AdminSimpleResponse);
    }
    return res.status(200).json({
      success: true,
      message: result.changed ? '회원등급이 변경되었습니다.' : '이미 동일한 등급입니다.',
    } satisfies AdminSimpleResponse);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('회원등급 변경 실패:', msg);
    return res.status(500).json({
      success: false,
      message: '회원등급을 변경하지 못했습니다. 다시 시도해 주세요.',
    } satisfies AdminSimpleResponse);
  }
});

/**
 * PATCH /internal/admin/users/:userId/memo
 * 요청: { memo: string } (최대 1,000자)
 * 관리자 메모 저장.
 */
adminRouter.patch('/users/:userId/memo', async (req, res) => {
  const { userId } = req.params;
  const { memo } = req.body ?? {};

  if (typeof memo !== 'string') {
    return res.status(400).json({
      success: false,
      message: 'memo는 문자열이어야 합니다.',
    } satisfies AdminSimpleResponse);
  }
  if (memo.length > ADMIN_MEMO_MAX) {
    return res.status(400).json({
      success: false,
      message: `메모는 최대 ${ADMIN_MEMO_MAX}자까지 가능합니다.`,
    } satisfies AdminSimpleResponse);
  }

  try {
    const result = await saveMemo(userId, memo);
    if (!result.ok) {
      return res.status(404).json({
        success: false,
        message: '회원을 찾을 수 없습니다.',
      } satisfies AdminSimpleResponse);
    }
    return res.status(200).json({
      success: true,
      message: '메모가 저장되었습니다.',
    } satisfies AdminSimpleResponse);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('관리자 메모 저장 실패:', msg);
    return res.status(500).json({
      success: false,
      message: '관리자 메모를 저장하지 못했습니다. 다시 시도해 주세요.',
    } satisfies AdminSimpleResponse);
  }
});

/**
 * GET /internal/admin/premium-applications
 * 처리 대기(PENDING) 프리미엄 신청 목록. applied_at 오름차순.
 */
adminRouter.get('/premium-applications', async (_req, res) => {
  try {
    const items = await listPremiumApplications();
    return res.status(200).json({ items } satisfies PremiumApplicationListResponse);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('프리미엄 신청 목록 조회 실패:', msg);
    return res.status(500).json({
      success: false,
      message: '신청 목록을 불러오지 못했습니다. 다시 시도해 주세요.',
    } satisfies AdminSimpleResponse);
  }
});

/**
 * PATCH /internal/admin/premium-applications/:applicationId/status
 * 요청: { status: 'APPROVED' | 'REJECTED' }
 * applications + users + activity_logs를 단일 RPC로 원자 처리.
 * 이미 처리된 건은 409, 비활성 회원은 409로 차단.
 */
adminRouter.patch('/premium-applications/:applicationId/status', async (req, res) => {
  const { applicationId } = req.params;
  const { status } = req.body ?? {};

  if (status !== 'APPROVED' && status !== 'REJECTED') {
    return res.status(400).json({
      success: false,
      message: 'status는 APPROVED 또는 REJECTED여야 합니다.',
    } satisfies AdminSimpleResponse);
  }

  try {
    const result = await processPremiumApplication(applicationId, status);
    if (!result.ok) {
      switch (result.reason) {
        case 'not_found':
          return res.status(404).json({
            success: false,
            message: '신청 건을 찾을 수 없습니다.',
          } satisfies AdminSimpleResponse);
        case 'already_processed':
          return res.status(409).json({
            success: false,
            message: '이미 처리된 신청 건입니다.',
          } satisfies AdminSimpleResponse);
        case 'inactive_user':
          return res.status(409).json({
            success: false,
            message: '비활성 회원의 신청 건은 처리할 수 없습니다.',
          } satisfies AdminSimpleResponse);
        default:
          return res.status(400).json({
            success: false,
            message: 'status는 APPROVED 또는 REJECTED여야 합니다.',
          } satisfies AdminSimpleResponse);
      }
    }
    return res.status(200).json({
      applicationId: result.applicationId,
      status: result.status,
      processedAt: result.processedAt,
    } satisfies ProcessApplicationResponse);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('프리미엄 신청 처리 실패:', msg);
    return res.status(500).json({
      success: false,
      message: '처리하지 못했습니다. 다시 시도해 주세요.',
    } satisfies AdminSimpleResponse);
  }
});

// ===== Korean's Hot News (관리자 직접 등록 + 예약 게시) =====
//
// MVP 정책:
//   - 내용(title/content/relatedStock)은 등록 후 수정 불가 → PATCH는 상태(+예약일시) 전환 전용.
//   - 삭제는 hard delete. (/internal/admin은 internalGuard 경유라 브라우저 CORS preflight 무관.)

/**
 * GET /internal/admin/hot-news
 * 핫뉴스 목록 (전체 상태, 등록일 최신순). 본문 미포함.
 */
adminRouter.get('/hot-news', async (_req, res) => {
  try {
    const items = await listHotNews();
    return res.status(200).json({ items } satisfies HotNewsListResponse);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('핫뉴스 목록 조회 실패:', msg);
    return res.status(500).json({
      success: false,
      message: '핫뉴스 목록을 불러오지 못했습니다. 다시 시도해 주세요.',
    } satisfies AdminSimpleResponse);
  }
});

/**
 * GET /internal/admin/hot-news/:id
 * 핫뉴스 단건 (편집용 — 한국어 원문 본문 포함).
 */
adminRouter.get('/hot-news/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const detail = await getHotNews(id);
    if (!detail) {
      return res.status(404).json({
        success: false,
        message: '핫뉴스를 찾을 수 없습니다.',
      } satisfies AdminSimpleResponse);
    }
    return res.status(200).json(detail);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('핫뉴스 단건 조회 실패:', msg);
    return res.status(500).json({
      success: false,
      message: '핫뉴스를 불러오지 못했습니다. 다시 시도해 주세요.',
    } satisfies AdminSimpleResponse);
  }
});

/**
 * POST /internal/admin/hot-news
 * 핫뉴스 등록. 한국어 원문 → 영문 가공 + 5개 언어 선제 번역 (부수효과).
 * 요청: { title, content, relatedStock: string[], status, scheduledAt? }
 */
adminRouter.post('/hot-news', async (req, res) => {
  const input = req.body as HotNewsCreateInput;

  const valid = validateCreateInput(input);
  if (!valid.ok) {
    return res.status(400).json({
      success: false,
      message: valid.message,
    } satisfies AdminSimpleResponse);
  }

  try {
    const id = await createHotNews(input);
    return res.status(201).json({
      success: true,
      message: '핫뉴스가 등록되었습니다.',
      id,
    } satisfies HotNewsCreateResponse);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('핫뉴스 등록 실패:', msg);
    return res.status(500).json({
      success: false,
      message: '뉴스를 저장하지 못했습니다. 다시 시도해 주세요.',
    } satisfies AdminSimpleResponse);
  }
});

/**
 * PATCH /internal/admin/hot-news/:id
 * 게시 상태 전환 전용 (MVP: 내용 수정 불가).
 * 요청: { status, scheduledAt? }
 */
adminRouter.patch('/hot-news/:id', async (req, res) => {
  const { id } = req.params;
  const patch = req.body as HotNewsStatusPatch;

  const valid = validateStatusPatch(patch);
  if (!valid.ok) {
    return res.status(400).json({
      success: false,
      message: valid.message,
    } satisfies AdminSimpleResponse);
  }

  try {
    const result = await changeHotNewsStatus(id, patch);
    if (!result.ok) {
      return res.status(404).json({
        success: false,
        message: '핫뉴스를 찾을 수 없습니다.',
      } satisfies AdminSimpleResponse);
    }
    return res.status(200).json({
      success: true,
      message: '핫뉴스 상태가 변경되었습니다.',
    } satisfies AdminSimpleResponse);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('핫뉴스 상태 변경 실패:', msg);
    return res.status(500).json({
      success: false,
      message: '뉴스를 저장하지 못했습니다. 다시 시도해 주세요.',
    } satisfies AdminSimpleResponse);
  }
});

/**
 * DELETE /internal/admin/hot-news/:id
 * 핫뉴스 실제 삭제 (hard delete). 번역은 FK cascade로 함께 삭제.
 */
adminRouter.delete('/hot-news/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await deleteHotNews(id);
    if (!result.ok) {
      return res.status(404).json({
        success: false,
        message: '핫뉴스를 찾을 수 없습니다.',
      } satisfies AdminSimpleResponse);
    }
    return res.status(200).json({
      success: true,
      message: '핫뉴스가 삭제되었습니다.',
    } satisfies AdminSimpleResponse);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('핫뉴스 삭제 실패:', msg);
    return res.status(500).json({
      success: false,
      message: '뉴스를 삭제하지 못했습니다. 다시 시도해 주세요.',
    } satisfies AdminSimpleResponse);
  }
});

// ===== Feature Flags (기능 노출 토글) =====

/**
 * GET /internal/admin/feature-flags
 * 현재 전체 flag 상태 (관리자 UI 초기 표시용).
 */
adminRouter.get('/feature-flags', async (_req, res) => {
  try {
    const flags = await getAllFlags();
    return res.status(200).json({ success: true, data: flags });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('feature-flags 조회 실패:', msg);
    return res.status(500).json({
      success: false,
      message: '기능 설정을 불러오지 못했습니다. 다시 시도해 주세요.',
    } satisfies AdminSimpleResponse);
  }
});

/**
 * PATCH /internal/admin/feature-flags
 * 요청: { priceGapPublic: boolean } (알려진 flag 키 1개 이상)
 * 응답: { success, data: <변경 후 전체 flag> }
 */
adminRouter.patch('/feature-flags', async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const entries = Object.entries(body);

  // 알려진 키 + boolean 값만 허용. 하나도 유효하지 않으면 400.
  const valid = entries.filter(([k, v]) => isKnownFlagKey(k) && typeof v === 'boolean');
  if (valid.length === 0) {
    return res.status(400).json({
      success: false,
      message: '변경할 flag 키와 boolean 값이 필요합니다.',
    } satisfies AdminSimpleResponse);
  }

  try {
    const updatedBy = req.admin?.adminId ?? null;
    let flags = await getAllFlags();
    for (const [k, v] of valid) {
      if (isKnownFlagKey(k)) flags = await setFlag(k, v as boolean, updatedBy);
    }
    return res.status(200).json({ success: true, data: flags });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('feature-flags 변경 실패:', msg);
    return res.status(500).json({
      success: false,
      message: '기능 설정을 변경하지 못했습니다. 다시 시도해 주세요.',
    } satisfies AdminSimpleResponse);
  }
});

// ===== 애널리틱스 통계 (콘솔 이벤트 통계 — events 요청서 §3) =====
//
// 전부 읽기 전용 GET. 0007_events.sql의 분석 뷰 3종을 service_role로 select 한다.
// from/to(YYYY-MM-DD) query 선택 — 미지정 시 최근 30일. day는 UTC 기준(프론트가 KST 변환).

/**
 * GET /internal/admin/analytics/dau
 * 일별 활성(로그인) 유저 + 총 이벤트량. analytics_dau 뷰.
 */
adminRouter.get('/analytics/dau', async (req, res) => {
  try {
    const rows = await getDau(parseRange(req.query));
    return res.status(200).json({ rows } satisfies AnalyticsDauResponse);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('analytics dau 조회 실패:', msg);
    return res.status(500).json({
      success: false,
      message: '통계를 불러오지 못했습니다. 다시 시도해 주세요.',
    } satisfies AdminSimpleResponse);
  }
});

/**
 * GET /internal/admin/analytics/funnel
 * 전환 퍼널 단계별 카운트. analytics_funnel_daily 뷰.
 * ?mode=total 이면 일별 대신 기간 합계 1건({ total }).
 */
adminRouter.get('/analytics/funnel', async (req, res) => {
  try {
    const range = parseRange(req.query);
    if (req.query.mode === 'total') {
      const total = await getFunnelTotal(range);
      return res.status(200).json({ total } satisfies AnalyticsFunnelTotalResponse);
    }
    const rows = await getFunnelDaily(range);
    return res.status(200).json({ rows } satisfies AnalyticsFunnelResponse);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('analytics funnel 조회 실패:', msg);
    return res.status(500).json({
      success: false,
      message: '통계를 불러오지 못했습니다. 다시 시도해 주세요.',
    } satisfies AdminSimpleResponse);
  }
});

/**
 * GET /internal/admin/analytics/events
 * 이벤트별 일 카운트. analytics_event_counts 뷰.
 * ?eventName=... 이면 해당 이벤트만 필터.
 */
adminRouter.get('/analytics/events', async (req, res) => {
  try {
    const eventName = typeof req.query.eventName === 'string' ? req.query.eventName : undefined;
    const rows = await getEventCounts(parseRange(req.query), eventName);
    return res.status(200).json({ rows } satisfies AnalyticsEventCountResponse);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('analytics events 조회 실패:', msg);
    return res.status(500).json({
      success: false,
      message: '통계를 불러오지 못했습니다. 다시 시도해 주세요.',
    } satisfies AdminSimpleResponse);
  }
});
