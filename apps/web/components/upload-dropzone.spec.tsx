import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { DictionaryProvider } from '@/lib/i18n/dictionary-context';
import { UploadDropzone } from './upload-dropzone';
import type { UploadAcceptedResult } from '@/lib/api/schemas';

vi.mock('@/lib/api/home-client', () => ({
  uploadInvoice: vi.fn(),
}));

const { uploadInvoice } = await import('@/lib/api/home-client');

function renderDropzone(
  onUploaded: (result: UploadAcceptedResult) => void = vi.fn(),
) {
  render(
    <DictionaryProvider locale="de">
      <UploadDropzone onUploaded={onUploaded} />
    </DictionaryProvider>,
  );
  return screen.getByLabelText('PDF hierher ziehen oder Datei auswählen');
}

function pdfFile(name = 'invoice.pdf', sizeBytes = 1024) {
  const file = new File([new Uint8Array(sizeBytes)], name, {
    type: 'application/pdf',
  });
  return file;
}

describe('UploadDropzone', () => {
  it('rejects a non-PDF file client-side without calling the API', async () => {
    vi.mocked(uploadInvoice).mockReset();
    const input = renderDropzone();
    const textFile = new File(['hello'], 'notes.txt', { type: 'text/plain' });

    fireEvent.change(input, { target: { files: [textFile] } });

    expect(
      await screen.findByText('Nur PDF-Dateien werden unterstützt.'),
    ).toBeTruthy();
    expect(uploadInvoice).not.toHaveBeenCalled();
  });

  it('rejects a file over 10 MB client-side without calling the API', async () => {
    vi.mocked(uploadInvoice).mockReset();
    const input = renderDropzone();
    const tooLarge = pdfFile('big.pdf', 10 * 1024 * 1024 + 1);

    fireEvent.change(input, { target: { files: [tooLarge] } });

    expect(
      await screen.findByText('Die Datei ist größer als 10 MB.'),
    ).toBeTruthy();
    expect(uploadInvoice).not.toHaveBeenCalled();
  });

  it('accepts a valid PDF under the size limit and reports the result', async () => {
    vi.mocked(uploadInvoice).mockReset();
    const result: UploadAcceptedResult = {
      id: 'inv-1',
      status: 'UPLOADED',
      deduplicated: false,
    };
    vi.mocked(uploadInvoice).mockResolvedValueOnce({ ok: true, data: result });
    const onUploaded = vi.fn();
    const input = renderDropzone(onUploaded);

    fireEvent.change(input, { target: { files: [pdfFile()] } });

    await vi.waitFor(() =>
      expect(onUploaded).toHaveBeenCalledWith(result, 'invoice.pdf'),
    );
    expect(uploadInvoice).toHaveBeenCalledTimes(1);
  });

  it('shows the server error and does not report success when the upload is rejected', async () => {
    vi.mocked(uploadInvoice).mockReset();
    vi.mocked(uploadInvoice).mockResolvedValueOnce({
      ok: false,
      error: { kind: 'rate_limited', retryAfterSeconds: 30 },
    });
    const onUploaded = vi.fn();
    const input = renderDropzone(onUploaded);

    fireEvent.change(input, { target: { files: [pdfFile()] } });

    expect(
      await screen.findByText(/Bitte in 30 Sekunden erneut versuchen/),
    ).toBeTruthy();
    expect(onUploaded).not.toHaveBeenCalled();
  });

  it('resets the input value after a selection so re-picking the same file fires change again', async () => {
    vi.mocked(uploadInvoice).mockReset();
    vi.mocked(uploadInvoice).mockResolvedValue({
      ok: true,
      data: { id: 'inv-1', status: 'UPLOADED', deduplicated: false },
    });
    const input = renderDropzone() as HTMLInputElement;

    fireEvent.change(input, { target: { files: [pdfFile()] } });
    await vi.waitFor(() => expect(uploadInvoice).toHaveBeenCalledTimes(1));

    expect(input.value).toBe('');
  });

  it('accepts only one upload while the current request is pending', async () => {
    vi.mocked(uploadInvoice).mockReset();
    let resolveUpload: (value: {
      ok: true;
      data: UploadAcceptedResult;
    }) => void = () => {};
    vi.mocked(uploadInvoice).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveUpload = resolve;
      }),
    );
    vi.mocked(uploadInvoice).mockResolvedValue({
      ok: true,
      data: { id: 'inv-2', status: 'UPLOADED', deduplicated: false },
    });
    const input = renderDropzone() as HTMLInputElement;

    fireEvent.change(input, { target: { files: [pdfFile('first.pdf')] } });
    fireEvent.change(input, { target: { files: [pdfFile('second.pdf')] } });

    await vi.waitFor(() => expect(uploadInvoice).toHaveBeenCalledTimes(1));
    expect(input.disabled).toBe(true);

    resolveUpload({
      ok: true,
      data: { id: 'inv-1', status: 'UPLOADED', deduplicated: false },
    });
    await vi.waitFor(() => expect(input.disabled).toBe(false));

    fireEvent.change(input, { target: { files: [pdfFile('third.pdf')] } });
    await vi.waitFor(() => expect(uploadInvoice).toHaveBeenCalledTimes(2));
  });
});
