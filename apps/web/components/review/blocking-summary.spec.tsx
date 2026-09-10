import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { DictionaryProvider } from '@/lib/i18n/dictionary-context';
import { BlockingSummary } from './blocking-summary';
import type { InvoiceFinding } from '@/lib/api/schemas';

function finding(overrides: Partial<InvoiceFinding>): InvoiceFinding {
  return {
    rule: 'mandatory.electronic_address',
    field: 'seller.electronicAddress',
    severity: 'ERROR',
    passed: false,
    message: 'Electronic address must be present.',
    expected: null,
    actual: null,
    ...overrides,
  };
}

describe('BlockingSummary', () => {
  it('renders one jump link per field when two findings share the same rule', () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});

    render(
      <DictionaryProvider locale="de">
        <BlockingSummary
          findings={[
            finding({ field: 'seller.electronicAddress' }),
            finding({ field: 'buyer.electronicAddress' }),
          ]}
          issues={[]}
        />
      </DictionaryProvider>,
    );

    expect(screen.getAllByRole('link')).toHaveLength(2);
    const duplicateKeyWarning = consoleError.mock.calls.some((call) =>
      String(call[0]).includes('two children with the same key'),
    );
    expect(duplicateKeyWarning).toBe(false);

    consoleError.mockRestore();
  });

  it('moves focus to the field container when a finding names no subfield', () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: false });

    const container = document.createElement('div');
    container.id = 'field-lineItems-0-';
    container.tabIndex = -1;
    container.scrollIntoView = vi.fn();
    document.body.appendChild(container);

    render(
      <DictionaryProvider locale="de">
        <BlockingSummary
          findings={[
            finding({
              rule: 'mandatory.line_vat_rate_or_exemption',
              field: 'lineItems[0]',
            }),
          ]}
          issues={[]}
        />
      </DictionaryProvider>,
    );

    fireEvent.click(screen.getByRole('link'));

    expect(document.activeElement).toBe(container);
    document.body.removeChild(container);
  });
});
