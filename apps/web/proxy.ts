import { NextResponse, type NextRequest } from 'next/server';
import { defaultLocale, isLocale } from './lib/i18n/locales';

function contentSecurityPolicy(nonce: string): string {
  const isDevelopment = process.env.NODE_ENV === 'development';
  const scriptSource = `'self' 'nonce-${nonce}' 'strict-dynamic'${
    isDevelopment ? " 'unsafe-eval'" : ''
  }`;
  const styleSource = isDevelopment
    ? "'self' 'unsafe-inline'"
    : `'self' 'nonce-${nonce}'`;

  return [
    "default-src 'self'",
    `script-src ${scriptSource}`,
    `style-src ${styleSource}`,
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "frame-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export function proxy(request: NextRequest): NextResponse {
  const locale = request.nextUrl.pathname.split('/')[1] ?? '';
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(
    'x-pdf-to-xrechnung-locale',
    isLocale(locale) ? locale : defaultLocale,
  );
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', contentSecurityPolicy(nonce));

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', contentSecurityPolicy(nonce));
  return response;
}

export const config = {
  matcher: [
    {
      source: '/((?!api|_next/static|_next/image|favicon.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
