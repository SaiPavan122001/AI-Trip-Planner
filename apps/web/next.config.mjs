/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The shared domain package is TypeScript source in this monorepo, so Next
  // compiles it rather than expecting a prebuilt bundle.
  transpilePackages: ['@trip/shared'],
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ];
  },
};

export default nextConfig;
