import { gzipSync } from 'node:zlib';

const baseURL = process.env.BUNDLE_BASE_URL ?? 'http://localhost:3000';
const routes = [
  { path: '/de', maxGzipBytes: 175_000 },
  {
    path: '/de/invoices/00000000-0000-4000-8000-000000000000',
    maxGzipBytes: 185_000,
  },
];

async function fetchBuffer(url) {
  const requestUrl = String(url);
  const response = await fetch(requestUrl);
  if (!response.ok)
    throw new Error(
      `Bundle request failed: url=${requestUrl}, status=${response.status}`,
    );
  return Buffer.from(await response.arrayBuffer());
}

for (const route of routes) {
  const html = (await fetchBuffer(`${baseURL}${route.path}`)).toString();
  const scripts = [
    ...new Set(
      [...html.matchAll(/<script[^>]+src="([^"]+)"/g)]
        .map((match) => match[1])
        .filter(
          (source) =>
            source?.includes('/_next/static/') &&
            !source.includes('polyfills-'),
        ),
    ),
  ];
  const chunks = await Promise.all(
    scripts.map((source) => fetchBuffer(new URL(source, baseURL))),
  );
  const rawBytes = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const gzipBytes = chunks.reduce(
    (total, chunk) => total + gzipSync(chunk).length,
    0,
  );
  process.stdout.write(
    `${JSON.stringify({ path: route.path, scripts: scripts.length, rawBytes, gzipBytes })}\n`,
  );
  if (gzipBytes > route.maxGzipBytes) {
    throw new Error(
      `${route.path} exceeds its ${route.maxGzipBytes}-byte gzip budget`,
    );
  }
}
