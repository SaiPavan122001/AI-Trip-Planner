import { describe, expect, it } from 'vitest';
import { loadProvidersEnv } from '../config.js';
import { blockedAddressReason, checkOutboundUrl, checkResolvedUrl, validateConfiguredUrl } from '../ssrf.js';

/**
 * Server-side request forgery (Phase 6.5). Every address and URL an attacker
 * would try, in every spelling that has ever worked against a naive check.
 */

describe('addresses that may never be reached', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', 'loopback'],
    ['0.0.0.0', 'this network'],
    ['10.0.0.1', 'private'],
    ['10.255.255.255', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.1.1', 'private'],
    ['169.254.169.254', 'metadata'], // AWS, GCP, Azure instance metadata
    ['169.254.0.1', 'link-local'],
    ['100.64.0.1', 'carrier-grade'],
    ['198.18.0.1', 'benchmarking'],
    ['224.0.0.1', 'multicast'],
    ['255.255.255.255', 'reserved'],
    ['::1', 'loopback'],
    ['::', 'unspecified'],
    ['fe80::1', 'link-local'],
    ['fc00::1', 'private'],
    ['fd12:3456:789a::1', 'private'],
    ['ff02::1', 'multicast'],
    ['::ffff:127.0.0.1', 'mapped loopback'],
    ['::ffff:7f00:1', 'mapped loopback (hex)'],
    ['::ffff:169.254.169.254', 'mapped metadata'],
    ['::ffff:10.0.0.1', 'mapped private'],
    ['64:ff9b::a00:1', 'NAT64 to 10.0.0.1'],
    ['2002:7f00:1::1', '6to4 of 127.0.0.1'],
    ['fe80::1%eth0', 'link-local with a zone'],
  ])('%s (%s) is blocked', (address) => {
    expect(blockedAddressReason(address)).not.toBeNull();
  });

  it.each(['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.0.1', '172.32.0.1', '100.63.255.255', '2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8'])(
    '%s is public',
    (address) => {
      expect(blockedAddressReason(address)).toBeNull();
    },
  );
});

describe('URLs', () => {
  const blocked = [
    ['file:///etc/passwd', 'scheme'],
    ['ftp://example.com/x', 'scheme'],
    ['gopher://example.com/', 'scheme'],
    ['javascript:alert(1)', 'scheme'],
    ['data:text/plain,hi', 'scheme'],
    ['http://localhost/', 'name'],
    ['http://LOCALHOST:8080/', 'name'],
    ['http://foo.localhost/', 'name'],
    ['http://metadata.google.internal/computeMetadata/v1/', 'metadata name'],
    ['http://service.internal/', 'internal name'],
    ['http://printer.local/', 'mDNS name'],
    ['http://127.0.0.1/', 'loopback'],
    ['http://127.1/', 'shortened loopback'],
    ['http://2130706433/', 'decimal loopback'],
    ['http://0x7f000001/', 'hex loopback'],
    ['http://0177.0.0.1/', 'octal loopback'],
    ['http://169.254.169.254/latest/meta-data/', 'metadata address'],
    ['http://[::1]/', 'IPv6 loopback'],
    ['http://[::ffff:127.0.0.1]/', 'IPv4-mapped loopback'],
    ['http://[fd00::1]/', 'IPv6 private'],
    ['http://10.1.2.3:9200/', 'private with a port'],
    ['http://user:pass@example.com/', 'credentials'],
    ['http://example.com@127.0.0.1/', 'credentials that hide the real host'],
    ['not a url', 'garbage'],
    ['', 'empty'],
  ] as const;

  it.each(blocked)('%s (%s) is refused', (url) => {
    expect(checkOutboundUrl(url).ok).toBe(false);
  });

  it('explains why, without echoing the URL back', () => {
    const verdict = checkOutboundUrl('http://169.254.169.254/latest/meta-data/');
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toMatch(/link-local/);
      expect(verdict.reason).not.toContain('169.254');
    }
  });

  it('accepts an ordinary public https URL, and normalises nothing away', () => {
    const verdict = checkOutboundUrl('https://nominatim.openstreetmap.org/search?q=goa');
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.url.hostname).toBe('nominatim.openstreetmap.org');
  });

  it('lets an operator point a provider at their own network, only when they say so', () => {
    expect(checkOutboundUrl('http://10.0.0.5:5000/', { allowPrivate: true }).ok).toBe(true);
    expect(checkOutboundUrl('http://localhost:5000/', { allowPrivate: true }).ok).toBe(true);
    expect(checkOutboundUrl('http://10.0.0.5:5000/').ok).toBe(false);
    // Credentials and odd schemes are never acceptable, private allowed or not.
    expect(checkOutboundUrl('file:///etc/passwd', { allowPrivate: true }).ok).toBe(false);
    expect(checkOutboundUrl('http://a:b@10.0.0.5/', { allowPrivate: true }).ok).toBe(false);
  });

  it('can insist on https, and on a list of hosts (exact or subdomain, never a lookalike)', () => {
    expect(checkOutboundUrl('http://example.com/', { requireHttps: true }).ok).toBe(false);
    const policy = { allowedHosts: ['example.com'] };
    expect(checkOutboundUrl('https://example.com/', policy).ok).toBe(true);
    expect(checkOutboundUrl('https://api.example.com/', policy).ok).toBe(true);
    expect(checkOutboundUrl('https://example.com.evil.test/', policy).ok).toBe(false);
    expect(checkOutboundUrl('https://notexample.com/', policy).ok).toBe(false);
  });
});

describe('names that point somewhere else', () => {
  const resolvesTo = (...addresses: string[]) => async () => addresses.map((address) => ({ address }));

  it('refuses a public-looking name that resolves to an internal address', async () => {
    const verdict = await checkResolvedUrl('https://harmless.example.com/', {}, resolvesTo('169.254.169.254'));
    expect(verdict.ok).toBe(false);
  });

  it('refuses if any one of several addresses is internal (DNS rebinding pairs a public with a private answer)', async () => {
    const verdict = await checkResolvedUrl('https://harmless.example.com/', {}, resolvesTo('93.184.216.34', '10.0.0.7'));
    expect(verdict.ok).toBe(false);
  });

  it('accepts a name that resolves only to public addresses', async () => {
    expect((await checkResolvedUrl('https://example.com/', {}, resolvesTo('93.184.216.34', '2606:4700:4700::1111'))).ok).toBe(true);
  });

  it('refuses a name that does not resolve, or resolves to nothing', async () => {
    expect((await checkResolvedUrl('https://example.com/', {}, async () => Promise.reject(new Error('ENOTFOUND')))).ok).toBe(false);
    expect((await checkResolvedUrl('https://example.com/', {}, resolvesTo())).ok).toBe(false);
  });

  it('does not resolve at all for what the text check already refused', async () => {
    let resolved = false;
    const verdict = await checkResolvedUrl('http://127.0.0.1/', {}, async () => ((resolved = true), []));
    expect(verdict.ok).toBe(false);
    expect(resolved).toBe(false);
  });
});

describe('configured provider URLs', () => {
  it('are validated at start-up, naming the setting', () => {
    expect(() => loadProvidersEnv({ OSRM_BASE_URL: 'file:///etc/passwd' })).toThrow(/OSRM_BASE_URL/);
    expect(() => loadProvidersEnv({ RAIL_PROVIDER_URL: 'ftp://rail.example.com' })).toThrow(/RAIL_PROVIDER_URL/);
    expect(() => loadProvidersEnv({ BUS_PROVIDER_URL: 'https://user:secret@bus.example.com' })).toThrow(/BUS_PROVIDER_URL/);
    expect(() => loadProvidersEnv({ NOMINATIM_BASE_URL: 'not a url' })).toThrow(/NOMINATIM_BASE_URL/);
  });

  it('never echo the credentials they were given', () => {
    try {
      loadProvidersEnv({ BUS_PROVIDER_URL: 'https://user:hunter2@bus.example.com' });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as Error).message).not.toContain('hunter2');
    }
  });

  it('may name a host on the operator\'s own network in development', () => {
    expect(loadProvidersEnv({ OSRM_BASE_URL: 'http://localhost:5000' }).osrm?.baseUrl).toBe('http://localhost:5000');
    expect(loadProvidersEnv({ OSRM_BASE_URL: 'http://10.0.0.5:5000/' }).osrm?.baseUrl).toBe('http://10.0.0.5:5000');
  });

  it('must be https in production, unless the host is the operator\'s own', () => {
    expect(() => validateConfiguredUrl('X_URL', 'http://api.example.com', { production: true })).toThrow(/https/);
    expect(validateConfiguredUrl('X_URL', 'https://api.example.com/', { production: true })).toBe('https://api.example.com');
    expect(validateConfiguredUrl('X_URL', 'http://10.0.0.5:5000', { production: true })).toBe('http://10.0.0.5:5000');
    expect(validateConfiguredUrl('X_URL', 'http://osrm.internal:5000', { production: true })).toBe('http://osrm.internal:5000');
  });
});
