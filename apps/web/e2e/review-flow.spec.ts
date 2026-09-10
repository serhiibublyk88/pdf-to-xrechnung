import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { buildMultiPagePdf } from '../../api/evals/pdf-builders';

const SAMPLE_PDF = path.resolve(
  __dirname,
  '../../api/evals/dataset/001-clean-de/invoice.pdf',
);
const SEED_SCRIPT = path.resolve(
  __dirname,
  '../../api/test/fixtures/seed-needs-review.mjs',
);
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for e2e tests');
}

function forceNeedsReview(invoiceId: string): void {
  execFileSync('node', [SEED_SCRIPT, invoiceId], {
    env: { ...process.env, DATABASE_URL },
    stdio: 'inherit',
  });
}

async function uploadAndReachReady(page: Page): Promise<string> {
  await page.goto('/de');
  await expect(page.locator('html')).toHaveAttribute('lang', 'de');
  await page
    .getByLabel('PDF hierher ziehen oder Datei auswählen')
    .setInputFiles(SAMPLE_PDF);

  const invoiceLink = page.getByRole('link', { name: 'invoice.pdf' });
  await expect(invoiceLink).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('link', { name: 'Herunterladen' })).toBeVisible({
    timeout: 30_000,
  });

  const href = await invoiceLink.getAttribute('href');
  const invoiceId = /\/invoices\/([0-9a-f-]{36})/.exec(href ?? '')?.[1];
  if (!invoiceId) {
    throw new Error(`Could not extract invoice id from href "${href ?? ''}"`);
  }
  return invoiceId;
}

test('upload, correct a field and download the regenerated XRechnung', async ({
  page,
}) => {
  const invoiceId = await uploadAndReachReady(page);

  forceNeedsReview(invoiceId);
  await page.goto('/de');
  await page.getByRole('link', { name: 'invoice.pdf' }).click();
  await page.waitForURL(new RegExp(`/de/invoices/${invoiceId}`));

  await expect(page.getByText('Schritt', { exact: false })).toBeVisible();

  const buyerReference = page.getByLabel('Leitweg-ID');
  await expect(buyerReference).toBeEnabled({ timeout: 15_000 });
  const correctedReference = '991-12345-67';
  await buyerReference.fill(correctedReference);

  await page.getByRole('button', { name: 'Prüfen und absenden' }).click();

  await expect(
    page.getByRole('heading', { name: 'Prüfen und absenden' }),
  ).toBeVisible();
  await expect(page.getByText(correctedReference)).toBeVisible();

  await page.getByRole('button', { name: 'Absenden' }).click();

  const downloadLink = page.getByRole('link', {
    name: 'XRechnung herunterladen',
  });
  await expect(downloadLink).toBeVisible({ timeout: 30_000 });

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    downloadLink.click(),
  ]);
  const downloadPath = await download.path();
  if (!downloadPath) {
    throw new Error('Expected the XRechnung download to save to disk');
  }
  const xml = await readFile(downloadPath, 'utf8');
  expect(xml).toContain('<?xml');
  expect(xml).toContain(correctedReference);
});

test('switching a VAT breakdown to reverse charge (AE) reaches READY and downloads XML with the implied reason code', async ({
  page,
}) => {
  const invoiceId = await uploadAndReachReady(page);

  forceNeedsReview(invoiceId);
  await page.goto(`/de/invoices/${invoiceId}`);

  await page.locator('#field-lineItems-0--vatRate-input').fill('0');
  await page.locator('#field-vatBreakdown-0--rate-input').fill('0');
  await page.locator('#field-vatBreakdown-0--amount-input').fill('0.00');
  await page
    .locator('#field-vatBreakdown-0--exemptionReason-input')
    .fill('Reverse charge');
  await page
    .locator('#field-vatBreakdown-0--category-input')
    .selectOption('AE');
  await page.locator('#field-buyer-vatId-input').fill('DE811907980');
  await page.getByLabel('Umsatzsteuergesamtbetrag').fill('0.00');
  await page.getByLabel('Rechnungsendbetrag').fill('100.00');

  await expect(
    page.getByText(
      'Wird übermittelt als: Steuerschuldnerschaft des Leistungsempfängers.',
    ),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Prüfen und absenden' }).click();
  await page.getByRole('button', { name: 'Absenden' }).click();

  const downloadLink = page.getByRole('link', {
    name: 'XRechnung herunterladen',
  });
  await expect(downloadLink).toBeVisible({ timeout: 30_000 });

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    downloadLink.click(),
  ]);
  const downloadPath = await download.path();
  if (!downloadPath) {
    throw new Error('Expected the XRechnung download to save to disk');
  }
  const xml = await readFile(downloadPath, 'utf8');
  expect(xml).toContain('<cbc:ID>AE</cbc:ID>');
  expect(xml).toContain(
    '<cbc:TaxExemptionReasonCode>VATEX-EU-AE</cbc:TaxExemptionReasonCode>',
  );
});

test('a German-formatted decimal is reported and leaves the form usable', async ({
  page,
}) => {
  const invoiceId = await uploadAndReachReady(page);

  forceNeedsReview(invoiceId);
  await page.goto(`/de/invoices/${invoiceId}`);

  const grossTotal = page.getByLabel('Rechnungsendbetrag');
  await expect(grossTotal).toBeEnabled({ timeout: 15_000 });
  const original = await grossTotal.inputValue();
  await grossTotal.fill('1.416,10');

  const reviewButton = page.getByRole('button', {
    name: 'Prüfen und absenden',
  });
  await reviewButton.click();

  await expect(
    page.getByRole('heading', { name: 'Prüfen und absenden' }),
  ).toHaveCount(0);
  await expect(
    page.getByText('Dezimaltrennzeichen', { exact: false }).first(),
  ).toBeVisible();
  await expect(grossTotal).toBeEnabled();
  await expect(reviewButton).toBeEnabled();

  await grossTotal.fill(original);
  await reviewButton.click();
  await expect(
    page.getByRole('heading', { name: 'Prüfen und absenden' }),
  ).toBeVisible();
});

test('serves the source PDF to the browser viewer without a blocking sandbox', async ({
  page,
}) => {
  const invoiceId = await uploadAndReachReady(page);

  forceNeedsReview(invoiceId);
  const sourceResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/invoices/${invoiceId}/source`) &&
      response.status() === 200,
  );
  await page.goto(`/de/invoices/${invoiceId}`);

  const response = await sourceResponse;
  expect(response.headers()['content-type']).toMatch(/^application\/pdf/);
  await expect(page.getByTitle('Quelldokument')).not.toHaveAttribute(
    'sandbox',
    /.*/,
  );
});

test('does not prefetch the adjacent locale before switching', async ({
  page,
}) => {
  const adjacentLocaleRequests: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (
      request.method() === 'GET' &&
      url.pathname === '/en' &&
      url.searchParams.has('_rsc')
    ) {
      adjacentLocaleRequests.push(request.url());
    }
  });

  await page.goto('/de');
  await page.waitForLoadState('networkidle');

  expect(adjacentLocaleRequests).toEqual([]);
});

test('an invalid one-segment locale path redirects to the default locale instead of an empty shell', async ({
  page,
}) => {
  const response = await page.goto('/foo');

  expect(response?.status()).toBe(200);
  expect(page.url()).toMatch(/\/de$/);
  await expect(page.locator('html')).toHaveAttribute('data-theme', /.+/);
});

test('a typed failure is translated after switching the locale', async ({
  page,
}) => {
  await page.goto('/de');
  await page
    .getByLabel('PDF hierher ziehen oder Datei auswählen')
    .setInputFiles({
      name: 'too-many-pages.pdf',
      mimeType: 'application/pdf',
      buffer: buildMultiPagePdf(Array.from({ length: 31 }, () => 'page')),
    });

  const invoiceLink = page.getByRole('link', { name: 'too-many-pages.pdf' });
  await expect(invoiceLink).toBeVisible({ timeout: 30_000 });
  const href = await invoiceLink.getAttribute('href');
  const invoiceId = /\/invoices\/([0-9a-f-]{36})/.exec(href ?? '')?.[1];
  if (!invoiceId) {
    throw new Error(`Could not extract invoice id from href "${href ?? ''}"`);
  }

  await invoiceLink.click();
  await expect(
    page.getByText(
      'Das PDF hat 31 Seiten und überschreitet das Limit von 30 Seiten.',
    ),
  ).toBeVisible({ timeout: 30_000 });

  const invoiceRequests: string[] = [];
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname;
    if (
      request.method() === 'GET' &&
      (pathname === `/api/invoices/${invoiceId}` ||
        pathname === `/api/invoices/${invoiceId}/review`)
    ) {
      invoiceRequests.push(request.url());
    }
  });

  await page.getByRole('link', { name: 'en', exact: true }).click();
  await page.waitForURL(`/en/invoices/${invoiceId}`);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page).toHaveTitle('PDF to XRechnung');
  await expect(page.locator('meta[name="description"]')).toHaveAttribute(
    'content',
    'Convert PDF invoices into XRechnung (EN 16931) — checked and correctable before download.',
  );
  await expect(
    page.getByText('The PDF has 31 pages, exceeding the 30-page limit.'),
  ).toBeVisible();
  expect(invoiceRequests).toHaveLength(0);
});
