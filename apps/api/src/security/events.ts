import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';
import type { Logger } from 'pino';

/**
 * Security events, and how a caller's address is kept in them.
 *
 * An address identifies a person closely enough to be personal data, and the
 * same address should be countable across requests (that is what a rate limit
 * is). Both are met by using a keyed hash of the address, never the address:
 * the counters, the Redis keys and the log lines carry a short tag that is
 * stable for one address, cannot be turned back into it without the secret,
 * and means nothing to anyone who copies the log.
 */

/**
 * The part of an address that identifies who is asking. IPv6 users are handed
 * a whole /64, so treating each address as a caller would let one person rotate
 * through billions of them; an IPv4-mapped IPv6 address is the IPv4 address.
 */
export function addressPrefix(ip: string): string {
  const raw = ip.trim().replace(/^\[|\]$/g, '').split('%')[0]!.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(raw);
  if (mapped) return mapped[1]!;
  if (isIP(raw) === 6) return `${expandV6(raw).slice(0, 4).join(':')}::/64`;
  return raw || 'unknown';
}

function expandV6(ip: string): string[] {
  const [head = '', tail = ''] = ip.split('::');
  const headGroups = head ? head.split(':') : [];
  const tailGroups = tail ? tail.split(':') : [];
  const fill = ip.includes('::') ? Array<string>(Math.max(0, 8 - headGroups.length - tailGroups.length)).fill('0') : [];
  return [...headGroups, ...fill, ...tailGroups].map((g) => g.padStart(4, '0'));
}

/** A short, stable, one-way tag for an address (or a /64), for counters and logs. */
export function addressTag(secret: string, ip: string): string {
  return createHmac('sha256', secret).update(`address:${addressPrefix(ip)}`).digest('hex').slice(0, 16);
}

export type SecurityEventKind =
  | 'rate_limited'
  | 'bad_origin'
  | 'cross_site_blocked'
  | 'sign_in_failed'
  | 'sign_in_locked'
  | 'session_expired'
  | 'idempotency_conflict'
  | 'overloaded'
  | 'quota_exceeded'
  | 'payload_too_large'
  | 'forbidden_provider_probe'
  | 'sessions_revoked'
  | 'ops_auth_failed';

/**
 * One structured line for something a person defending this service would want
 * to search for. It carries what happened, on which route, and who by (the
 * address tag and, if signed in, the user id), and nothing a caller wrote: not
 * a body, a header, a cookie, a query string or an email address.
 */
export function securityEvent(
  logger: Logger,
  kind: SecurityEventKind,
  who: { route?: string; method?: string; address?: string; userId?: string | null },
  detail: Record<string, string | number | boolean | null> = {},
): void {
  logger.warn({ security: kind, ...who, ...detail }, `security event: ${kind}`);
}
