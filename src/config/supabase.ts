import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';
import { env } from './env';

/**
 * service_role 키를 사용하는 서버 전용 Supabase 클라이언트.
 * RLS를 우회하므로 절대 클라이언트(브라우저)에 노출하지 말 것.
 *
 * Node 20 환경에서 Supabase Realtime이 native WebSocket을 찾지 못해
 * Railway 배포 시 "Node.js 20 detected without native WebSocket support"
 * 오류가 발생하므로 ws 패키지를 transport로 주입한다.
 */
export const supabase = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
  realtime: {
    // ws 생성자 타입이 Supabase의 WebSocketLikeConstructor와 정확히 일치하지 않으나
    // 런타임 동작은 호환된다. (Node 20 native WebSocket 부재 대응)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    transport: WebSocket as any,
  },
});
