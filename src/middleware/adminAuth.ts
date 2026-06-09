import type { Request, Response, NextFunction } from 'express';
import { verifyAdminToken } from '../services/admin.service';
import type { AdminJwtPayload, AdminSimpleResponse } from '../types';

/** adminAuth 통과 시 req.admin 에 주입되는 토큰 payload */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      admin?: AdminJwtPayload;
    }
  }
}

/**
 * 관리자 전용 라우트 보호 미들웨어.
 * Authorization: Bearer <token> 검증 → 무효/만료 시 401.
 * PRD: 인증 만료 시 프론트는 로그인 페이지로 리다이렉트("세션이 만료되었습니다").
 */
export function adminAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({
      success: false,
      message: '세션이 만료되었습니다. 다시 로그인해 주세요.',
    } satisfies AdminSimpleResponse);
    return;
  }

  const token = header.slice('Bearer '.length).trim();
  const payload = verifyAdminToken(token);
  if (!payload) {
    res.status(401).json({
      success: false,
      message: '세션이 만료되었습니다. 다시 로그인해 주세요.',
    } satisfies AdminSimpleResponse);
    return;
  }

  req.admin = payload;
  next();
}
