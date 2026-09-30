/**
 * Security headers for every page.
 *
 * The content security policy is what stops a script that got into a page from
 * running or reporting: only this site's own scripts, only our API to talk to,
 * no plugins, no framing, no changing where forms post. Next.js inlines a few
 * scripts of its own, so inline scripts are allowed (a nonce per request would
 * tighten that, and needs middleware this app does not have); in development
 * its hot reloading also needs eval. Both are the framework's requirements,
 * not the app's, and the app itself renders every value as text.
 */
const isProduction = process.env.NODE_ENV === 'production';
const apiOrigin = (() => {
  try {
    return new URL(process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000').origin;
  } catch {
    return 'http://localhost:4000';
  }
})();

const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isProduction ? '' : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  `connect-src 'self' ${apiOrigin}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  ...(isProduction ? ['upgrade-insecure-requests'] : []),
].join('; ');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Do not announce the framework.
  poweredByHeader: false,
  // The shared domain package is TypeScript source in this monorepo, so Next
  // compiles it rather than expecting a prebuilt bundle.
  transpilePackages: ['@trip/shared'],
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
          // Nothing here needs the camera, the microphone, the location or a payment: say so.
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()' },
          ...(isProduction ? [{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' }] : []),
        ],
      },
    ];
  },
};

export default nextConfig;
