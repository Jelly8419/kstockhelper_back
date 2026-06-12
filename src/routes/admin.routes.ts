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
import { logger } from '../utils/logger';
import type {
  AdminLoginResponse,
  AdminSimpleResponse,
  AdminUserListResponse,
  ApiTier,
  PremiumApplicationListResponse,
  ProcessApplicationResponse,
} from '../types';

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
