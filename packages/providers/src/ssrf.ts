import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * Server-side request forgery guard.
 *
 * No API input is used as a URL today: places and codes are query parameters
 * and every base URL is operator configuration. This exists for the three ways
 * a request could still be steered somewhere it should not go: a redirect from
 * a provider, a URL found in a provider's response, and (one day) a URL a
 * traveller supplies. It refuses anything that is not plain http(s) to a public
 * address: no other schemes, no credentials in the URL, and no loopback,
 * private, link-local, carrier-grade NAT, multicast, reserved or cloud-metadata
 * address, in any spelling (`http://2130706433/`, `http://[::ffff:7f00:1]/`,
 * and names that resolve to them are all caught).
 *
 * An operator may deliberately point a provider at a private host (a
 * self-hosted routing server on the same network); that is what `allowPrivate`
 * is for, and it is only ever passed for URLs the operator wrote.
 */

export interface OutboundUrlPolicy {
  /** Operator-configured URLs may name a private host; anything derived from a response may not. */
  allowPrivate?: boolean;
  /** Refuse plain http (production configuration, and redirects that would downgrade). */
  requireHttps?: boolean;
  /** If given, the host must be one of these (exactly, or a subdomain of one). */
  allowedHosts?: readonly string[];
}

export type UrlCheck = { ok: true; url: URL } | { ok: false; reason: string };

const BLOCKED_NAMES = new Set(['localhost', 'metadata', 'metadata.google.internal', 'instance-data']);
const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.localdomain', '.home.arpa'];

/** Why an IP address may not be reached, or null if it is a public one. */
export function blockedAddressReason(address: string): string | null {
  const raw = address.trim().replace(/^\[|\]$/g, '');
  // A zone id (fe80::1%eth0) is not part of the address.
  const ip = raw.split('%')[0]!.toLowerCase();
  const family = isIP(ip);
  if (family === 4) return blockedV4(ip.split('.').map(Number) as [number, number, number, number]);
  if (family === 6) return blockedV6(ip);
  return 'not an IP address';
}

function blockedV4([a, b, c]: [number, number, number, number]): string | null {
  if (a === 0) return 'the "this network" range';
  if (a === 10) return 'a private address';
  if (a === 127) return 'a loopback address';
  if (a === 100 && b >= 64 && b <= 127) return 'a carrier-grade NAT address';
  if (a === 169 && b === 254) return 'a link-local address (including cloud metadata services)';
  if (a === 172 && b >= 16 && b <= 31) return 'a private address';
  if (a === 192 && b === 0 && c === 0) return 'a reserved address';
  if (a === 192 && b === 0 && c === 2) return 'a documentation address';
  if (a === 192 && b === 168) return 'a private address';
  if (a === 198 && (b === 18 || b === 19)) return 'a benchmarking address';
  if (a === 198 && b === 51 && c === 100) return 'a documentation address';
  if (a === 203 && b === 0 && c === 113) return 'a documentation address';
  if (a >= 224 && a <= 239) return 'a multicast address';
  if (a >= 240) return 'a reserved address';
  return null;
}

/** Expands an IPv6 address to its eight 16-bit groups. */
function groupsOfV6(ip: string): number[] | null {
  let text = ip;
  // An embedded IPv4 tail (::ffff:1.2.3.4) is two groups.
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (tail) {
    const parts = tail[1]!.split('.').map(Number);
    if (parts.length !== 4 || parts.some((p) => p > 255)) return null;
    text = `${text.slice(0, -tail[1]!.length)}${((parts[0]! << 8) | parts[1]!).toString(16)}:${((parts[2]! << 8) | parts[3]!).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - rest.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const all = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...rest];
  const groups = all.map((g) => parseInt(g || '0', 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

function blockedV6(ip: string): string | null {
  const g = groupsOfV6(ip);
  if (!g) return 'not a valid IPv6 address';
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [number, number, number, number, number, number, number, number];
  const embeddedV4 = (hi: number, lo: number): [number, number, number, number] => [hi >> 8, hi & 255, lo >> 8, lo & 255];
  if (g.every((x) => x === 0)) return 'the unspecified address';
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 1) return 'a loopback address';
  // IPv4-mapped (::ffff:a.b.c.d) and the deprecated IPv4-compatible form: judged as the IPv4 address inside.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0xffff || g5 === 0)) {
    return blockedV4(embeddedV4(g6, g7)) ?? (g5 === 0 ? 'an IPv4-compatible address' : null);
  }
  // NAT64 (64:ff9b::/96): the IPv4 address inside is the destination.
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return blockedV4(embeddedV4(g6, g7));
  // 6to4 (2002::/16) carries an IPv4 address in the next 32 bits.
  if (g0 === 0x2002) return blockedV4(embeddedV4(g1, g2)) ?? null;
  if ((g0 & 0xfe00) === 0xfc00) return 'a unique-local (private) address';
  if ((g0 & 0xffc0) === 0xfe80) return 'a link-local address';
  if ((g0 & 0xffc0) === 0xfec0) return 'a site-local address';
  if ((g0 & 0xff00) === 0xff00) return 'a multicast address';
  if (g0 === 0x2001 && g1 === 0x0db8) return 'a documentation address';
  return null;
}

/**
 * Judges a URL by its text alone (no DNS): scheme, credentials, host name and
 * literal addresses. `new URL` has already folded every spelling of an IPv4
 * address (decimal, hex, octal, shortened) to dotted form by the time this
 * looks at it.
 */
export function checkOutboundUrl(raw: string, policy: OutboundUrlPolicy = {}): UrlCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'not a valid URL' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, reason: `the scheme "${url.protocol.replace(':', '')}" is not allowed` };
  }
  if (policy.requireHttps && url.protocol !== 'https:') return { ok: false, reason: 'plain http is not allowed here' };
  if (url.username || url.password) return { ok: false, reason: 'credentials in the URL are not allowed' };

  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return { ok: false, reason: 'no host' };

  if (policy.allowedHosts && !policy.allowedHosts.some((h) => host === h.toLowerCase() || host.endsWith(`.${h.toLowerCase()}`))) {
    return { ok: false, reason: 'the host is not on the allow-list' };
  }

  if (!policy.allowPrivate) {
    const literal = host.startsWith('[') ? host : isIP(host) ? host : null;
    if (literal !== null) {
      const why = blockedAddressReason(literal);
      if (why) return { ok: false, reason: `the address is ${why}` };
    } else {
      if (BLOCKED_NAMES.has(host) || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) {
        return { ok: false, reason: 'the host name is reserved for internal use' };
      }
    }
  }
  return { ok: true, url };
}

export type Resolver = (hostname: string) => Promise<Array<{ address: string }>>;

const systemResolver: Resolver = (hostname) => dnsLookup(hostname, { all: true });

/**
 * `checkOutboundUrl`, and then the name is resolved and every address it
 * resolves to must be public too, so a public-looking name that points at an
 * internal address (or that is re-pointed between the check and the request)
 * is refused. For URLs that come from outside the operator's configuration.
 */
export async function checkResolvedUrl(
  raw: string,
  policy: OutboundUrlPolicy = {},
  resolve: Resolver = systemResolver,
): Promise<UrlCheck> {
  const first = checkOutboundUrl(raw, policy);
  if (!first.ok || policy.allowPrivate) return first;
  const host = first.url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) return first;
  let addresses: Array<{ address: string }>;
  try {
    addresses = await resolve(host);
  } catch {
    return { ok: false, reason: 'the host name could not be resolved' };
  }
  if (addresses.length === 0) return { ok: false, reason: 'the host name did not resolve' };
  for (const { address } of addresses) {
    const why = blockedAddressReason(address);
    if (why) return { ok: false, reason: `the host name resolves to ${why}` };
  }
  return first;
}

/**
 * For configuration read at start-up. A malformed or unsafe base URL stops the
 * service with a message naming the setting, instead of failing on the first
 * request. Production must use https unless the host is one the operator
 * plainly runs themselves (a private address or `localhost`).
 */
export function validateConfiguredUrl(name: string, raw: string, opts: { production: boolean }): string {
  const lenient = checkOutboundUrl(raw, { allowPrivate: true });
  if (!lenient.ok) throw new Error(`${name} is not usable: ${lenient.reason}.`);
  if (opts.production && lenient.url.protocol !== 'https:') {
    const host = lenient.url.hostname.replace(/^\[|\]$/g, '');
    const internal = host === 'localhost' || (isIP(host) !== 0 && blockedAddressReason(host) !== null) || BLOCKED_SUFFIXES.some((s) => host.endsWith(s));
    if (!internal) throw new Error(`${name} must use https in production.`);
  }
  return raw.replace(/\/+$/, '');
}
