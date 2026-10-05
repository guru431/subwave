// Connection precedence shared by boot, maintenance workers and setup status.
// Multi-station profiles never inherit installation-wide music credentials.
import { envStr, envUrl } from '../util/env.js';

export interface NavidromeCredentials {
  url?: string;
  user?: string;
  pass?: string;
}

export function navidromeEnvLocks(allowEnv: boolean) {
  return {
    url: allowEnv && !!process.env.NAVIDROME_URL,
    user: allowEnv && !!process.env.NAVIDROME_USER,
    pass: allowEnv && !!process.env.NAVIDROME_PASS,
  };
}

export function resolveNavidrome(nv: NavidromeCredentials = {}, allowEnv = false) {
  const locks = navidromeEnvLocks(allowEnv);
  return {
    url: locks.url ? envUrl('NAVIDROME_URL', 'http://navidrome:4533')
      : nv.url || (allowEnv ? 'http://navidrome:4533' : ''),
    user: locks.user ? envStr('NAVIDROME_USER', '') : nv.user || '',
    password: locks.pass ? process.env.NAVIDROME_PASS! : nv.pass || '',
  };
}

export function hasNavidrome(nv: NavidromeCredentials | undefined): boolean {
  return !!nv && [nv.url, nv.user, nv.pass].every(v => typeof v === 'string' && v.trim() !== '');
}
