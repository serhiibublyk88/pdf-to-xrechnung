import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DictionaryProvider } from '@/lib/i18n/dictionary-context';
import { ConfirmPanel } from './confirm-panel';
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

function expectNoDuplicateKeyWarning(
  consoleError: ReturnType<typeof vi.spyOn>,
) {
  const duplicateKeyWarning = consoleError.mock.calls.some((call) =>
    String(call[0]).includes('two children with the same key'),
  );
  expect(duplicateKeyWarning).toBe(false);
}

describe('ConfirmPanel', () => {
  it('renders untouched findings that share a rule name without a key collision', () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});

    render(
      <DictionaryProvider locale="de">
        <ConfirmPanel
          changes={[]}
          blockingFindings={[
            finding({ field: 'seller.electronicAddress' }),
            finding({ field: 'buyer.electronicAddress' }),
          ]}
          isSubmitting={false}
          error={null}
          onBack={() => {}}
          onSubmit={() => {}}
        />
      </DictionaryProvider>,
    );

    expect(screen.getAllByText(/Elektronische Adresse/)).toHaveLength(2);
    expectNoDuplicateKeyWarning(consoleError);
    consoleError.mockRestore();
  });

  it('renders rechecked findings that share a rule name without a key collision', () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});

    render(
      <DictionaryProvider locale="de">
        <ConfirmPanel
          changes={[
            { path: 'seller.electronicAddress', before: null, after: 'a@b.de' },
            { path: 'buyer.electronicAddress', before: null, after: 'c@d.de' },
          ]}
          blockingFindings={[
            finding({ field: 'seller.electronicAddress' }),
            finding({ field: 'buyer.electronicAddress' }),
          ]}
          isSubmitting={false}
          error={null}
          onBack={() => {}}
          onSubmit={() => {}}
        />
      </DictionaryProvider>,
    );

    expectNoDuplicateKeyWarning(consoleError);
    consoleError.mockRestore();
  });
});
