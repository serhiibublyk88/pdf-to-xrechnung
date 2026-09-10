import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { getExtractionMode } from '@/lib/api/extraction-mode-client';
import { DictionaryProvider } from '@/lib/i18n/dictionary-context';
import { DemoModeNotice } from './demo-mode-notice';

vi.mock('@/lib/api/extraction-mode-client', () => ({
  getExtractionMode: vi.fn(),
}));

const DEMO_TEXT = /Demomodus/;

function renderNotice() {
  return render(
    <DictionaryProvider locale="de">
      <DemoModeNotice />
    </DictionaryProvider>,
  );
}

describe('DemoModeNotice', () => {
  beforeEach(() => {
    vi.mocked(getExtractionMode).mockReset();
  });

  it('tells the reader that the mock provider ignores the uploaded PDF', async () => {
    vi.mocked(getExtractionMode).mockResolvedValue({
      ok: true,
      data: { demo: true },
    });

    renderNotice();

    expect(await screen.findByText(DEMO_TEXT)).toBeTruthy();
  });

  it('stays hidden when a real provider extracts the PDF', async () => {
    vi.mocked(getExtractionMode).mockResolvedValue({
      ok: true,
      data: { demo: false },
    });

    renderNotice();

    await vi.waitFor(() => expect(getExtractionMode).toHaveBeenCalled());
    expect(screen.queryByText(DEMO_TEXT)).toBeNull();
  });
});
