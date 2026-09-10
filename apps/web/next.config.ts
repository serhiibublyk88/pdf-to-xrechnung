import type { NextConfig } from 'next';
import { join } from 'node:path';

if (!process.env.API_ORIGIN && process.env.NODE_ENV === 'production') {
  throw new Error('API_ORIGIN must be set in production');
}
const apiOrigin = process.env.API_ORIGIN ?? 'http://localhost:3000';

const nextConfig: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: join(__dirname, '../..'),
  poweredByHeader: false,
  headers() {
    return Promise.resolve([
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          {
            key: 'Permissions-Policy',
            value:
              'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
          },
        ],
      },
    ]);
  },
  rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${apiOrigin}/:path*`,
      },
    ];
  },
};

export default nextConfig;
