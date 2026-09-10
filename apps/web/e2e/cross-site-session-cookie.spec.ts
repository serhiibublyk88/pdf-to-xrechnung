import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type Page } from '@playwright/test';

// `localhost` and `127.0.0.1` are distinct SameSite "sites", so this is a genuine cross-site caller.
const API_ORIGIN = process.env.API_ORIGIN ?? 'http://localhost:3000';

async function startAttackerOrigin(): Promise<{
  origin: string;
  close: () => Promise<void>;
}> {
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>attacker</title>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

async function fetchStatusFromCurrentOrigin(
  page: Page,
  path: string,
): Promise<number> {
  return page.evaluate(async (url) => {
    const response = await fetch(url, { credentials: 'include' });
    return response.status;
  }, path);
}

test('a cross-site page cannot reuse an existing owner session cookie', async ({
  page,
}) => {
  await page.goto(`${API_ORIGIN}/health/live`);

  const sessionStatus = await page.evaluate(async () => {
    const response = await fetch('/sessions', {
      method: 'POST',
      credentials: 'include',
    });
    return response.status;
  });
  expect(sessionStatus).toBe(204);

  const sameSiteStatus = await fetchStatusFromCurrentOrigin(page, '/invoices');
  expect(sameSiteStatus).toBe(200);

  const attacker = await startAttackerOrigin();
  try {
    await page.goto(attacker.origin);

    // No CORS headers, so the response status is unobservable — assert on request headers instead.
    const [request] = await Promise.all([
      Promise.race([
        page.waitForEvent(
          'requestfinished',
          (req) => req.url() === `${API_ORIGIN}/invoices`,
        ),
        page.waitForEvent(
          'requestfailed',
          (req) => req.url() === `${API_ORIGIN}/invoices`,
        ),
      ]),
      page.evaluate((apiOrigin) => {
        fetch(`${apiOrigin}/invoices`, { credentials: 'include' }).catch(
          () => undefined,
        );
      }, API_ORIGIN),
    ]);
    const headers = await request.allHeaders();

    expect(headers['cookie']).toBeUndefined();
  } finally {
    await attacker.close();
  }
});
