import { expect, test } from '@playwright/test';

test('serves the document with a nonce CSP and without X-Powered-By', async ({
  page,
}) => {
  const response = await page.goto('/de');
  const headers = response?.headers() ?? {};
  const csp = headers['content-security-policy'] ?? '';

  expect(csp).toContain("script-src 'self' 'nonce-");
  expect(csp).toContain("'strict-dynamic'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).not.toContain('upgrade-insecure-requests');
  expect(headers['x-powered-by']).toBeUndefined();
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['referrer-policy']).toBe('no-referrer');
  expect(headers['permissions-policy']).toContain('camera=()');

  const cspNonce = /script-src[^;]*'nonce-([^']+)'/.exec(csp)?.[1];
  expect(cspNonce).toBeTruthy();
  const documentNonce = await page
    .locator('script[nonce]')
    .first()
    .evaluate((element) =>
      element instanceof HTMLScriptElement ? element.nonce : null,
    );
  expect(documentNonce).toBe(cspNonce);

  if (process.env.PLAYWRIGHT_EXPECT_PRODUCTION === 'true') {
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).not.toContain("'unsafe-inline'");
  }
});

test('declares the global smooth-scroll behavior to Next.js', async ({
  page,
}) => {
  await page.goto('/de');

  await expect(page.locator('html')).toHaveAttribute(
    'data-scroll-behavior',
    'smooth',
  );
});

test('serves an icon instead of redirecting the browser to a locale route', async ({
  request,
}) => {
  const response = await request.get('/favicon.ico', { maxRedirects: 0 });

  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toMatch(/^image\//);
});

test('keeps invoice routes out of crawlers', async ({ request }) => {
  const response = await request.get('/robots.txt', { maxRedirects: 0 });

  expect(response.status()).toBe(200);
  expect(await response.text()).toContain('Disallow: /de/invoices/');
});

test('renders native form controls in the active colour scheme', async ({
  page,
}) => {
  const colorScheme = () =>
    page.evaluate(() => getComputedStyle(document.documentElement).colorScheme);

  await page.goto('/de');
  expect(await colorScheme()).toBe('dark');

  await page.evaluate(() => localStorage.setItem('theme', 'light'));
  await page.reload();

  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await colorScheme()).toBe('light');
});
