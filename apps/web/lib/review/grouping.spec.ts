import { describe, expect, it } from 'vitest';
import { groupInvoices, hasNonTerminal } from './grouping';
import type { InvoiceListItem } from '@/lib/api/schemas';

function invoice(overrides: Partial<InvoiceListItem> = {}): InvoiceListItem {
  return {
    id: 'inv-1',
    originalFilename: 'invoice.pdf',
    status: 'UPLOADED',
    createdAt: '2026-08-26T00:00:00.000Z',
    expiresAt: '2026-08-26T02:00:00.000Z',
    failure: null,
    ...overrides,
  };
}

describe('groupInvoices', () => {
  it('sorts invoices into needsReview, inProgress, ready and failed', () => {
    const groups = groupInvoices([
      invoice({ id: 'a', status: 'NEEDS_REVIEW' }),
      invoice({ id: 'b', status: 'EXTRACTING_TEXT' }),
      invoice({ id: 'c', status: 'READY' }),
      invoice({ id: 'd', status: 'FAILED' }),
    ]);

    expect(groups.map((g) => g.id)).toEqual([
      'needsReview',
      'inProgress',
      'ready',
      'failed',
    ]);
    expect(groups.map((g) => g.invoices.map((i) => i.id))).toEqual([
      ['a'],
      ['b'],
      ['c'],
      ['d'],
    ]);
  });

  it('omits an empty group entirely rather than rendering it blank', () => {
    const groups = groupInvoices([invoice({ status: 'READY' })]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.id).toBe('ready');
  });

  it('returns no groups for an empty list', () => {
    expect(groupInvoices([])).toEqual([]);
  });

  it('collapses every non-terminal status into inProgress', () => {
    const nonTerminalStatuses = [
      'UPLOADED',
      'EXTRACTING_TEXT',
      'TEXT_READY',
      'EXTRACTING_DATA',
      'DATA_READY',
      'VALIDATING',
      'GENERATING',
      'GENERATING_DOCUMENT',
    ] as const;

    const groups = groupInvoices(
      nonTerminalStatuses.map((status, index) =>
        invoice({ id: String(index), status }),
      ),
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]?.id).toBe('inProgress');
    expect(groups[0]?.invoices).toHaveLength(nonTerminalStatuses.length);
  });
});

describe('hasNonTerminal', () => {
  it('is true when any invoice is still in progress', () => {
    expect(
      hasNonTerminal([
        invoice({ status: 'READY' }),
        invoice({ status: 'EXTRACTING_DATA' }),
      ]),
    ).toBe(true);
  });

  it('is false once every invoice has reached a terminal status', () => {
    expect(
      hasNonTerminal([
        invoice({ status: 'READY' }),
        invoice({ status: 'FAILED' }),
        invoice({ status: 'NEEDS_REVIEW' }),
      ]),
    ).toBe(false);
  });

  it('is false for an empty list', () => {
    expect(hasNonTerminal([])).toBe(false);
  });
});
