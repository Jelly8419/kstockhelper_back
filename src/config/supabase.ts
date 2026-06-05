import { createClient } from '@supabase/supabase-js';
import { env } from './env';

/**
 * service_role 키를 사용하는 서버 전용 Supabase 클라이언트.
 * RLS를 우회하므로 절대 클라이언트(브라우저)에 노출하지 말 것.
 */
export const supabase = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});
