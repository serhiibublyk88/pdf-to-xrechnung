import { parentPort, workerData } from 'node:worker_threads';
import { PDFParse } from 'pdf-parse';

if (!parentPort) {
  throw new Error('PDF text worker requires a parent port');
}

const parser = new PDFParse({ data: new Uint8Array(workerData.pdf) });
try {
  const info = await parser.getInfo();
  if (info.total > workerData.maxPages) {
    parentPort.postMessage({
      ok: false,
      type: 'too_many_pages',
      pageCount: info.total,
    });
  } else {
    const pdfText = await parser.getText();
    const charCount = pdfText.pages.reduce(
      (total, page) => total + page.text.length,
      0,
    );
    if (charCount > workerData.maxExtractedTextChars) {
      parentPort.postMessage({ ok: false, type: 'text_too_long', charCount });
    } else {
      parentPort.postMessage({
        ok: true,
        total: pdfText.total,
        pages: pdfText.pages.map((page) => ({
          pageNumber: page.num,
          text: page.text,
        })),
      });
    }
  }
} catch (error) {
  parentPort.postMessage({
    ok: false,
    type: 'error',
    message: error instanceof Error ? error.message : String(error),
  });
} finally {
  await parser.destroy();
}
