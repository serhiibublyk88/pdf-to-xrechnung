import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import {
  buildImagePdf,
  buildMultiPageImagePdf,
  buildMultiPagePdf,
} from './pdf-builders';
import {
  GoldenFixtureSchema,
  type GoldenFixture,
} from './golden-fixture.schema';

const datasetRoot = join(__dirname, 'dataset');
const templateRoot = join(__dirname, 'templates');
const a4PageSize = { width: 595.276, height: 841.89 };

interface ScanProfile {
  width: number;
  height: number;
  quality: number;
  filter?: string;
  rotateDeg?: number;
}

// Width is the dominant knob at the 300 DPI OCR re-render.
function scanProfile(
  scanQuality: GoldenFixture['meta']['scanQuality'],
): ScanProfile {
  switch (scanQuality) {
    case 'clean':
      return { width: 1240, height: 1754, quality: 90 };
    case 'degraded':
      // Measured mean confidence ~86.9, above the 80 gate.
      return {
        width: 620,
        height: 877,
        quality: 75,
        filter: 'grayscale(1) contrast(0.78) blur(0.35px)',
        rotateDeg: -0.2,
      };
    case 'illegible':
      // Measured mean confidence ~68.9, below the 80 gate.
      return {
        width: 400,
        height: 566,
        quality: 20,
        filter: 'grayscale(1) contrast(0.65) blur(0.6px)',
        rotateDeg: -0.8,
      };
    case 'blank':
    case undefined:
      throw new Error(`Unexpected scanQuality for OCR fixture: ${scanQuality}`);
  }
}

type Layout = 'compact' | 'centered-totals' | 'repeating-chrome' | 'standard';

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function show(value: string | null): string {
  return value === null ? '—' : escapeHtml(value);
}

function selectLayout(id: string): Layout {
  if (id === '009-unusual-layout-de') return 'centered-totals';
  if (id === '010-repeating-chrome-de') return 'repeating-chrome';
  if (id === '007-many-lines-de') return 'compact';
  return 'standard';
}

function templateFor(layout: Layout): string {
  return readFileSync(join(templateRoot, `${layout}.html`), 'utf8');
}

function partyBlock(
  label: string,
  fixture: GoldenFixture,
  role: 'buyer' | 'seller',
): string {
  const party = fixture.data[role];
  return `<section><h2>${label}</h2><strong>${show(party.name)}</strong><br>${show(party.street)}<br>${show(party.postalCode)} ${show(party.city)}<br>${show(party.countryCode)}<br>VAT ID: ${show(party.vatId)}<br>Endpoint: ${show(party.electronicAddress)} (${show(party.electronicAddressScheme)})<br>Contact: ${show(party.contactName)}, ${show(party.contactEmail)}, ${show(party.contactPhone)}</section>`;
}

function invoiceBody(fixture: GoldenFixture, layout: Layout): string {
  if (fixture.meta.content === 'not-an-invoice') {
    return `<header><h1>Service agreement</h1><div>Reference: ${escapeHtml(fixture.meta.id)}</div></header><p>This agreement describes a prospective collaboration. It is not an invoice and contains no billing request.</p>`;
  }

  const { data } = fixture;
  const lineRows = data.lineItems
    .map(
      (line, index) =>
        `${layout === 'repeating-chrome' && index === 1 ? '<tr class="page-break"><td colspan="6">Internal copy — invoice detail</td></tr>' : ''}<tr><td>${show(line.position?.toString() ?? null)}</td><td>${show(line.description)}</td><td class="number">${show(line.quantity)}</td><td>${show(line.unit)}</td><td class="number">${show(line.unitPrice)} ${show(data.currency)}</td><td class="number">${show(line.netAmount)} ${show(data.currency)}<br>VAT ${show(line.vatRate)}%</td></tr>`,
    )
    .join('');
  const vatRows = data.vatBreakdown
    .map(
      (entry) =>
        `<tr><td>VAT ${show(entry.rate)}%</td><td class="number">${show(entry.base)} ${show(data.currency)}</td><td class="number">${show(entry.amount)} ${show(data.currency)}</td></tr>`,
    )
    .join('');
  const pageBreak = [
    '003-multipage-de',
    '007-many-lines-de',
    '010-repeating-chrome-de',
  ].includes(fixture.meta.id)
    ? '<div class="page-break"></div>'
    : '';
  const chrome =
    layout === 'repeating-chrome'
      ? `<p class="footer">Northwind Services · ${escapeHtml(fixture.meta.id)} · accounting copy</p>`
      : '';

  return `<header><h1>Invoice</h1><div class="metadata"><span>Invoice number</span><strong>${show(data.invoiceNumber)}</strong><span>Issue date</span><span>${show(data.issueDate)}</span><span>Due date</span><span>${show(data.dueDate)}</span><span>Delivery date</span><span>${show(data.deliveryDate)}</span><span>Buyer reference</span><span>${show(data.buyerReference)}</span></div></header><div class="parties">${partyBlock('Seller', fixture, 'seller')}${partyBlock('Buyer', fixture, 'buyer')}</div><table><thead><tr><th>Pos.</th><th>Description</th><th class="number">Quantity</th><th>Unit</th><th class="number">Unit price</th><th class="number">Net amount</th></tr></thead><tbody>${lineRows}</tbody></table>${pageBreak}${chrome}<table class="totals"><tbody>${vatRows}<tr><td>Net total</td><td class="number">${show(data.netTotal)} ${show(data.currency)}</td></tr><tr><td>VAT total</td><td class="number">${show(data.vatTotal)} ${show(data.currency)}</td></tr><tr class="gross"><td>Gross total</td><td class="number">${show(data.grossTotal)} ${show(data.currency)}</td></tr></tbody></table><p class="footer">Payment terms: ${show(data.paymentTerms)} · IBAN: ${show(data.sellerIban)} · BIC: ${show(data.sellerBic)}</p>`;
}

function loadFixture(caseDirectory: string): GoldenFixture {
  const source: unknown = JSON.parse(
    readFileSync(join(datasetRoot, caseDirectory, 'ground-truth.json'), 'utf8'),
  );
  return GoldenFixtureSchema.parse(source);
}

function selectedCaseDirectories(): string[] {
  const only = process.argv[2];
  const caseDirectories = readdirSync(datasetRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  if (!only) return caseDirectories;
  if (!caseDirectories.includes(only)) {
    throw new Error(`Unknown evaluation case: ${only}`);
  }
  return [only];
}

async function renderFixture(caseDirectory: string): Promise<void> {
  const fixture = loadFixture(caseDirectory);
  const outputPath = join(datasetRoot, caseDirectory, 'invoice.pdf');
  if (fixture.meta.scanQuality === 'blank') {
    writeFileSync(outputPath, buildMultiPagePdf([null]));
    return;
  }

  const layout = selectLayout(fixture.meta.id);
  const html = templateFor(layout)
    .replaceAll('{{LANGUAGE}}', fixture.meta.language)
    .replaceAll('{{HEADER}}', `Invoice ${fixture.meta.id}`)
    .replaceAll('{{FOOTER}}', `Invoice ${fixture.meta.id}`)
    .replace('{{BODY}}', invoiceBody(fixture, layout));
  const browser = await chromium.launch({ headless: true });
  try {
    if (fixture.meta.sourceType === 'ocr') {
      const profile = scanProfile(fixture.meta.scanQuality);
      const page = await browser.newPage({
        viewport: { width: profile.width, height: profile.height },
      });
      await page.setContent(html, { waitUntil: 'load' });
      if (profile.filter) {
        await page.addStyleTag({
          content: `body { filter: ${profile.filter}; transform: rotate(${profile.rotateDeg}deg); transform-origin: center; }`,
        });
      }
      const jpeg = await page.screenshot({
        type: 'jpeg',
        quality: profile.quality,
      });
      writeFileSync(
        outputPath,
        fixture.meta.pages === 1
          ? buildImagePdf({
              jpeg,
              width: profile.width,
              height: profile.height,
              pageWidth: a4PageSize.width,
              pageHeight: a4PageSize.height,
            })
          : buildMultiPageImagePdf({
              jpeg,
              width: profile.width,
              height: profile.height,
              pageCount: fixture.meta.pages,
              pageWidth: a4PageSize.width,
              pageHeight: a4PageSize.height,
            }),
      );
      return;
    }
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    await page.pdf({
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
      path: outputPath,
    });
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  const caseDirectories = selectedCaseDirectories();
  for (const caseDirectory of caseDirectories) {
    await renderFixture(caseDirectory);
  }
  process.stdout.write(`Rendered ${caseDirectories.length} golden fixtures\n`);
}

void main();
