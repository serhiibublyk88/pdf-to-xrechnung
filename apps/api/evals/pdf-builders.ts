interface ImagePdfOptions {
  height: number;
  jpeg: Buffer;
  pageHeight?: number;
  pageWidth?: number;
  width: number;
}

function objectBuffer(object: Buffer | string): Buffer {
  return Buffer.isBuffer(object) ? object : Buffer.from(object, 'ascii');
}

function assemblePdf(objects: Buffer[]): Buffer {
  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n', 'ascii')];
  const offsets: number[] = [];
  let byteLength = Buffer.byteLength('%PDF-1.4\n', 'ascii');

  for (const [index, object] of objects.entries()) {
    offsets.push(byteLength);
    const objectHeader = Buffer.from(`${index + 1} 0 obj\n`, 'ascii');
    const objectFooter = Buffer.from('\nendobj\n', 'ascii');
    parts.push(objectHeader, object, objectFooter);
    byteLength += objectHeader.length + object.length + objectFooter.length;
  }

  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    xref += `${offset.toString().padStart(10, '0')} 00000 n \n`;
  }
  parts.push(
    Buffer.from(
      `${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${byteLength}\n%%EOF`,
      'ascii',
    ),
  );
  return Buffer.concat(parts);
}

export function buildImagePdf({
  height,
  jpeg,
  width,
  pageHeight,
  pageWidth,
}: ImagePdfOptions): Buffer {
  const mediaBoxHeight = pageHeight ?? height;
  const mediaBoxWidth = pageWidth ?? width;
  const content = `q\n${mediaBoxWidth} 0 0 ${mediaBoxHeight} 0 0 cm\n/Im0 Do\nQ\n`;
  return assemblePdf([
    objectBuffer('<< /Type /Catalog /Pages 2 0 R >>'),
    objectBuffer('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    objectBuffer(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${mediaBoxWidth} ${mediaBoxHeight}] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>`,
    ),
    objectBuffer(
      `<< /Length ${Buffer.byteLength(content, 'ascii')} >>\nstream\n${content}endstream`,
    ),
    Buffer.concat([
      Buffer.from(
        `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
        'ascii',
      ),
      jpeg,
      Buffer.from('\nendstream', 'ascii'),
    ]),
  ]);
}

export function buildMultiPageImagePdf({
  height,
  jpeg,
  pageCount,
  width,
  pageHeight,
  pageWidth,
}: ImagePdfOptions & { pageCount: number }): Buffer {
  const mediaBoxHeight = pageHeight ?? height;
  const mediaBoxWidth = pageWidth ?? width;
  const firstPageObject = 3;
  const firstContentObject = firstPageObject + pageCount;
  const imageObject = firstContentObject + pageCount;
  const pageObjects = Array.from(
    { length: pageCount },
    (_, index) => firstPageObject + index,
  );
  const content = `q\n${mediaBoxWidth} 0 0 ${mediaBoxHeight} 0 0 cm\n/Im0 Do\nQ\n`;
  const contentObject = objectBuffer(
    `<< /Length ${Buffer.byteLength(content, 'ascii')} >>\nstream\n${content}endstream`,
  );
  return assemblePdf([
    objectBuffer('<< /Type /Catalog /Pages 2 0 R >>'),
    objectBuffer(
      `<< /Type /Pages /Kids [${pageObjects.map((object) => `${object} 0 R`).join(' ')}] /Count ${pageCount} >>`,
    ),
    ...pageObjects.map((_, index) =>
      objectBuffer(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${mediaBoxWidth} ${mediaBoxHeight}] /Resources << /XObject << /Im0 ${imageObject} 0 R >> >> /Contents ${firstContentObject + index} 0 R >>`,
      ),
    ),
    ...pageObjects.map(() => contentObject),
    Buffer.concat([
      Buffer.from(
        `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
        'ascii',
      ),
      jpeg,
      Buffer.from('\nendstream', 'ascii'),
    ]),
  ]);
}

export function buildMultiPagePdf(pageTexts: (string | null)[]): Buffer {
  const pageCount = pageTexts.length;
  const firstPageObject = 4;
  const firstContentObject = firstPageObject + pageCount;
  const pageObjects = Array.from(
    { length: pageCount },
    (_, index) => firstPageObject + index,
  );
  const contentObjects = Array.from(
    { length: pageCount },
    (_, index) => firstContentObject + index,
  );
  const objects = [
    objectBuffer('<< /Type /Catalog /Pages 2 0 R >>'),
    objectBuffer(
      `<< /Type /Pages /Kids [${pageObjects.map((object) => `${object} 0 R`).join(' ')}] /Count ${pageCount} >>`,
    ),
    objectBuffer('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'),
    ...pageObjects.map((_, index) =>
      objectBuffer(
        `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 3 0 R >> >> /MediaBox [0 0 612 792] /Contents ${contentObjects[index]} 0 R >>`,
      ),
    ),
    ...pageTexts.map((text) => {
      const content =
        text === null
          ? ''
          : `BT /F1 10 Tf 40 700 Td (${text
              .replace(/\\/g, '\\\\')
              .replace(/\(/g, '\\(')
              .replace(/\)/g, '\\)')}) Tj ET`;
      return objectBuffer(
        `<< /Length ${Buffer.byteLength(content, 'ascii')} >>\nstream\n${content}\nendstream`,
      );
    }),
  ];
  return assemblePdf(objects);
}

export function buildMinimalPdf(text: string): Buffer {
  return buildMultiPagePdf([text]);
}

export function buildZeroPagePdf(): Buffer {
  return assemblePdf([
    objectBuffer('<< /Type /Catalog /Pages 2 0 R >>'),
    objectBuffer('<< /Type /Pages /Kids [] /Count 0 >>'),
  ]);
}
