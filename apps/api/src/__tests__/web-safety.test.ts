import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The web application's protections (Phase 6.7), checked from here because the
 * web workspace has no test runner of its own. These are searches of its source
 * for what must never be there, and reads of its configuration for what must
 * be: the framework escapes everything it renders, so the way to keep that true
 * is to never step around it.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, '../../../web');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(tsx?|jsx?|mjs)$/.test(name)) out.push(full);
  }
  return out;
}

const files = ['app', 'components', 'lib'].flatMap((d) => sourceFiles(join(WEB, d)));
const read = (f: string) => readFileSync(f, 'utf8');

describe('what the pages render', () => {
  it('finds the web source it is meant to check', () => {
    expect(files.length).toBeGreaterThan(15);
  });

  it.each([
    ['dangerouslySetInnerHTML', /dangerouslySetInnerHTML/],
    ['innerHTML or outerHTML', /\.(inner|outer)HTML\s*=/],
    ['insertAdjacentHTML', /insertAdjacentHTML/],
    ['document.write', /document\.write/],
    ['eval or the Function constructor', /\beval\s*\(|new Function\s*\(/],
    ['a javascript: or data: URL', /['"`](javascript|data):/i],
    ['setting location from data', /(window\.)?location(\.href)?\s*=\s*(?!['"`]\/)/],
    ['window.open', /window\.open\s*\(/],
    ['storing anything sensitive in web storage', /(local|session)Storage\.setItem\s*\(\s*['"`](token|session|cookie|password|email)/i],
    ['reading the session cookie', /document\.cookie/],
  ])('never uses %s', (_name, pattern) => {
    const offenders = files.filter((f) => pattern.test(read(f))).map((f) => f.slice(WEB.length));
    expect(offenders).toEqual([]);
  });

  it('only ever puts an API-supplied address into a link after checking it is http or https', () => {
    const page = read(join(WEB, 'app/trips/page.tsx'));
    expect(page).toContain('safeHttpLink(sent.devLink)');
    expect(page).not.toMatch(/href=\{sent\.devLink\}/);
    // Every remaining href is a route of this app or the export address built from configuration.
    for (const f of files) {
      for (const m of read(f).matchAll(/href=\{([^}]+)\}/g)) {
        expect(m[1], `${f.slice(WEB.length)} has href={${m[1]}}`).toMatch(/^(`\/|api\.exportUrl|safeHttpLink\()/);
      }
    }
  });

  it('opens no link in a new tab without cutting the opener off', () => {
    for (const f of files) {
      for (const m of read(f).matchAll(/target=["']_blank["'][^>]*/g)) expect(m[0]).toMatch(/noopener/);
    }
  });
});

describe('the headers every page carries', () => {
  const config = read(join(WEB, 'next.config.mjs'));

  it('include a content security policy that stops scripts and forms going anywhere unexpected, and framing', () => {
    expect(config).toContain('Content-Security-Policy');
    for (const directive of ["default-src 'self'", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'"]) {
      expect(config).toContain(directive);
    }
    // Connections go to this site and the configured API, and nowhere else.
    expect(config).toMatch(/connect-src 'self' \$\{apiOrigin\}/);
    expect(config).not.toMatch(/script-src[^\n]*\*/);
    expect(config).not.toMatch(/default-src[^\n]*\*/);
  });

  it('include the other browser protections, and no framework banner', () => {
    for (const header of ['X-Content-Type-Options', 'Referrer-Policy', 'X-Frame-Options', 'Cross-Origin-Opener-Policy', 'Permissions-Policy', 'Strict-Transport-Security']) {
      expect(config).toContain(header);
    }
    expect(config).toContain('poweredByHeader: false');
    expect(config).toMatch(/payment=\(\)/); // no payment surface exists, so none may be requested
  });

  it('allows eval only outside production', () => {
    expect(config).toMatch(/isProduction \? '' : " 'unsafe-eval'"/);
  });
});

describe('the address a link is built from', () => {
  it('is accepted only if it is http or https', async () => {
    const { safeHttpLink } = await import('../../../web/lib/api.js' as string).catch(() => import('../../../web/lib/api.ts' as string));
    expect(safeHttpLink('https://app.example.com/auth/verify?token=abc')).toBe('https://app.example.com/auth/verify?token=abc');
    expect(safeHttpLink('http://localhost:3000/x')).toBe('http://localhost:3000/x');
    for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<script>alert(1)</script>', 'file:///etc/passwd', 'vbscript:x', '//evil.example', '/relative', '', null, undefined, 'not a url']) {
      expect(safeHttpLink(bad as string)).toBeNull();
    }
  });
});
