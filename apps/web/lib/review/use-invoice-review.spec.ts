import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, startTransition, Suspense, use } from 'react';
import { act, render, renderHook, waitFor } from '@testing-library/react';
import { getInvoiceReview, getInvoiceStatus } from '@/lib/api/client';
import type { ApiResult } from '@/lib/api/errors';
import type { InvoiceDetail, InvoiceStatusResult } from '@/lib/api/schemas';
import { POLL_INTERVAL_MS } from '@/lib/polling/use-polling';
import { useInvoiceReview } from './use-invoice-review';

vi.mock('@/lib/api/client', () => ({
  getInvoiceReview: vi.fn(),
  getInvoiceStatus: vi.fn(),
}));

const status = {
  id: 'invoice-1',
  status: 'FAILED' as const,
  sourceType: 'NATIVE' as const,
  pageCount: 1,
  failure: null,
};

describe('useInvoiceReview retry polling', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    vi.mocked(getInvoiceStatus).mockResolvedValue({ ok: true, data: status });
    vi.mocked(getInvoiceReview).mockResolvedValue({
      ok: false,
      error: { kind: 'network_error' },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('does not spend retry attempts while the tab is hidden', async () => {
    const visibilitySpy = vi
      .spyOn(document, 'visibilityState', 'get')
      .mockReturnValue('hidden');
    const { result } = renderHook(() => useInvoiceReview('invoice-1'));

    await act(async () => {
      result.current.onRetried();
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    expect(result.current.retryGaveUp).toBe(false);
    expect(getInvoiceStatus).toHaveBeenCalledTimes(2);
    visibilitySpy.mockRestore();
  });

  it('recovers when the initial status request fails transiently', async () => {
    vi.mocked(getInvoiceStatus)
      .mockResolvedValueOnce({
        ok: false,
        error: { kind: 'network_error' },
      })
      .mockResolvedValueOnce({ ok: true, data: status });
    const { result } = renderHook(() => useInvoiceReview('invoice-1'));
    await waitFor(() => expect(getInvoiceStatus).toHaveBeenCalledTimes(1));
    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });

    await waitFor(() => expect(result.current.status).toEqual(status));
    expect(getInvoiceStatus).toHaveBeenCalledTimes(2);
  });

  it('stops polling after the invoice is reported missing', async () => {
    vi.mocked(getInvoiceStatus).mockResolvedValue({
      ok: false,
      error: { kind: 'not_found' },
    });
    vi.mocked(getInvoiceReview).mockResolvedValue({
      ok: false,
      error: { kind: 'not_found' },
    });
    const { result } = renderHook(() => useInvoiceReview('invoice-1'));
    await waitFor(() => expect(getInvoiceStatus).toHaveBeenCalledTimes(1));
    await act(async () => {
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.notFound).toBe(true));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });

    expect(getInvoiceStatus).toHaveBeenCalledTimes(1);
  });
});

describe('useInvoiceReview initial snapshot', () => {
  const generatingDetail: InvoiceDetail = {
    id: 'invoice-1',
    originalFilename: 'invoice.pdf',
    status: 'GENERATING',
    sourceType: 'NATIVE',
    pageCount: 1,
    failure: null,
    expiresAt: '2026-09-10T12:00:00.000Z',
    reviewedAt: null,
    extractedData: null,
    lifecycleToken: null,
    findings: [],
    deadLetter: null,
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    vi.mocked(getInvoiceStatus).mockReset();
    vi.mocked(getInvoiceReview).mockReset();
    vi.mocked(getInvoiceReview)
      .mockResolvedValueOnce({ ok: true, data: generatingDetail })
      .mockResolvedValue({
        ok: true,
        data: { ...generatingDetail, status: 'READY' },
      });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('refreshes a detail snapshot that is older than the initial status', async () => {
    vi.mocked(getInvoiceStatus).mockResolvedValue({
      ok: true,
      data: { ...status, status: 'READY' },
    });

    const { result } = renderHook(() => useInvoiceReview('invoice-1'));

    await vi.waitFor(() => expect(result.current.detail?.status).toBe('READY'));
  });

  it('refreshes the detail when the first successful status follows a failed initial status', async () => {
    vi.mocked(getInvoiceStatus)
      .mockResolvedValueOnce({ ok: false, error: { kind: 'network_error' } })
      .mockResolvedValue({ ok: true, data: { ...status, status: 'READY' } });
    const { result } = renderHook(() => useInvoiceReview('invoice-1'));
    await vi.waitFor(() =>
      expect(result.current.detail?.status).toBe('GENERATING'),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    });

    await vi.waitFor(() => expect(result.current.detail?.status).toBe('READY'));
  });

  it('keeps polling until a stale terminal status catches up with a newer detail', async () => {
    vi.mocked(getInvoiceStatus)
      .mockResolvedValueOnce({
        ok: true,
        data: { ...status, status: 'NEEDS_REVIEW' },
      })
      .mockResolvedValue({ ok: true, data: { ...status, status: 'READY' } });
    const { result } = renderHook(() => useInvoiceReview('invoice-1'));
    await vi.waitFor(() => expect(result.current.detail?.status).toBe('READY'));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    });

    await vi.waitFor(() => expect(result.current.status?.status).toBe('READY'));
  });
});

describe('useInvoiceReview slow status responses', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    vi.mocked(getInvoiceStatus).mockReset();
    vi.mocked(getInvoiceReview).mockReset();
    vi.mocked(getInvoiceReview).mockResolvedValue({
      ok: false,
      error: { kind: 'network_error' },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('applies a poll response that arrives after the next interval tick', async () => {
    let resolveSlowPoll: (
      value: ApiResult<InvoiceStatusResult>,
    ) => void = () => {};
    vi.mocked(getInvoiceStatus)
      .mockResolvedValueOnce({
        ok: true,
        data: { ...status, status: 'GENERATING' },
      })
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveSlowPoll = resolve;
        }),
      )
      .mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useInvoiceReview('invoice-1'));
    await vi.waitFor(() =>
      expect(result.current.status?.status).toBe('GENERATING'),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2);
    });
    await act(async () => {
      resolveSlowPoll({ ok: true, data: { ...status, status: 'READY' } });
      await Promise.resolve();
    });

    expect(result.current.status?.status).toBe('READY');
  });
});

describe('useInvoiceReview request ordering', () => {
  beforeEach(() => {
    vi.mocked(getInvoiceStatus).mockReset();
    vi.mocked(getInvoiceReview).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('ignores an older status response after a newer retry poll response', async () => {
    let resolveOlderStatus: (value: {
      ok: true;
      data: typeof status;
    }) => void = () => {};
    vi.mocked(getInvoiceStatus)
      .mockResolvedValueOnce({ ok: true, data: status })
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveOlderStatus = resolve;
        }),
      )
      .mockResolvedValueOnce({
        ok: true,
        data: { ...status, status: 'NEEDS_REVIEW' },
      });
    vi.mocked(getInvoiceReview).mockResolvedValue({
      ok: false,
      error: { kind: 'network_error' },
    });
    const { result } = renderHook(() => useInvoiceReview('invoice-1'));
    await waitFor(() => expect(result.current.status?.status).toBe('FAILED'));

    void act(() => result.current.onRetried());
    await waitFor(() => expect(getInvoiceStatus).toHaveBeenCalledTimes(2));
    void act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() =>
      expect(result.current.status?.status).toBe('NEEDS_REVIEW'),
    );

    await act(async () => {
      resolveOlderStatus({ ok: true, data: status });
      await Promise.resolve();
    });

    expect(result.current.status?.status).toBe('NEEDS_REVIEW');
  });

  it('ignores a status response belonging to the previous invoice', async () => {
    let resolvePreviousStatus: (value: {
      ok: true;
      data: typeof status;
    }) => void = () => {};
    vi.mocked(getInvoiceStatus)
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolvePreviousStatus = resolve;
        }),
      )
      .mockResolvedValue({
        ok: true,
        data: { ...status, id: 'invoice-2', status: 'NEEDS_REVIEW' },
      });
    vi.mocked(getInvoiceReview).mockResolvedValue({
      ok: false,
      error: { kind: 'network_error' },
    });

    const { result, rerender } = renderHook(({ id }) => useInvoiceReview(id), {
      initialProps: { id: 'invoice-1' },
    });
    rerender({ id: 'invoice-2' });
    await waitFor(() =>
      expect(result.current.status?.status).toBe('NEEDS_REVIEW'),
    );

    await act(async () => {
      resolvePreviousStatus({ ok: true, data: status });
      await Promise.resolve();
    });

    expect(result.current.status?.status).toBe('NEEDS_REVIEW');
  });

  it('keeps the review capability usable after the invoice id changes', async () => {
    vi.mocked(getInvoiceStatus).mockResolvedValue({ ok: true, data: status });
    vi.mocked(getInvoiceReview).mockResolvedValue({
      ok: false,
      error: { kind: 'network_error' },
    });

    const { result, rerender } = renderHook(({ id }) => useInvoiceReview(id), {
      initialProps: { id: 'invoice-1' },
    });
    await waitFor(() => expect(result.current.status?.status).toBe('FAILED'));
    rerender({ id: 'invoice-2' });
    await waitFor(() =>
      expect(getInvoiceStatus).toHaveBeenCalledWith('invoice-2'),
    );
    const callsBeforeRetry = vi.mocked(getInvoiceStatus).mock.calls.length;

    await act(async () => {
      result.current.onRetried();
      await Promise.resolve();
    });

    expect(vi.mocked(getInvoiceStatus).mock.calls.length).toBeGreaterThan(
      callsBeforeRetry,
    );
  });
});

describe('useInvoiceReview concurrent rendering', () => {
  beforeEach(() => {
    vi.mocked(getInvoiceStatus).mockReset();
    vi.mocked(getInvoiceReview).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not reload the current invoice after an abandoned concurrent render', async () => {
    vi.mocked(getInvoiceStatus).mockResolvedValue({ ok: true, data: status });
    vi.mocked(getInvoiceReview).mockResolvedValue({
      ok: false,
      error: { kind: 'network_error' },
    });

    const pending = new Promise<never>(() => {});
    function Suspender({ suspend }: { suspend: boolean }) {
      if (suspend) use(pending);
      return null;
    }
    function Harness({ id, suspend }: { id: string; suspend: boolean }) {
      useInvoiceReview(id);
      return createElement(Suspender, { suspend });
    }
    const tree = (id: string, suspend: boolean) =>
      createElement(
        Suspense,
        { fallback: null },
        createElement(Harness, { id, suspend }),
      );

    const { rerender } = render(tree('invoice-1', false));
    await waitFor(() => expect(getInvoiceReview).toHaveBeenCalledTimes(1));
    const loadsBeforeTransition = vi.mocked(getInvoiceReview).mock.calls.length;

    await act(async () => {
      startTransition(() => {
        rerender(tree('invoice-2', true));
      });
      await Promise.resolve();
    });
    await act(async () => {
      rerender(tree('invoice-1', false));
      await Promise.resolve();
    });

    expect(vi.mocked(getInvoiceReview).mock.calls.length).toBe(
      loadsBeforeTransition,
    );
  });
});
