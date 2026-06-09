/**
 * 관리자 계정 수동 생성 CLI (PRD: 관리자 계정은 DB에서 수동 생성).
 *
 * 사용법:
 *   npx tsx scripts/createAdmin.ts <adminId> <password>
 *
 * 이미 존재하는 adminId면 비밀번호를 갱신한다(upsert).
 */
import bcrypt from 'bcryptjs';
import { supabase } from '../src/config/supabase';
import { logger } from '../src/utils/logger';

const BCRYPT_ROUNDS = 10;

async function main(): Promise<void> {
  const [, , adminId, password] = process.argv;

  if (!adminId || !password) {
    console.error('사용법: npx tsx scripts/createAdmin.ts <adminId> <password>');
    process.exit(1);
  }
  if (password.length < 8) {
    console.error('비밀번호는 최소 8자 이상이어야 합니다.');
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  // 존재 여부 확인 → insert 또는 update
  const { data: existing, error: selErr } = await supabase
    .from('admins')
    .select('id')
    .eq('admin_id', adminId)
    .limit(1);

  if (selErr) {
    logger.error('admins 조회 실패:', selErr.message);
    process.exit(1);
  }

  if (existing && existing.length > 0) {
    const { error } = await supabase
      .from('admins')
      .update({ password_hash: passwordHash })
      .eq('admin_id', adminId);
    if (error) {
      logger.error('관리자 비밀번호 갱신 실패:', error.message);
      process.exit(1);
    }
    logger.info(`관리자 비밀번호 갱신 완료 — adminId=${adminId}`);
  } else {
    const { error } = await supabase
      .from('admins')
      .insert({ admin_id: adminId, password_hash: passwordHash });
    if (error) {
      logger.error('관리자 생성 실패:', error.message);
      process.exit(1);
    }
    logger.info(`관리자 생성 완료 — adminId=${adminId}`);
  }

  process.exit(0);
}

main();
