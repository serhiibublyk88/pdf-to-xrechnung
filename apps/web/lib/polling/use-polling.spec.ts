import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { usePolling } from './use-polling';

describe('usePolling', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls the callback on each tick while enabled', async () => {
    const callback = vi.fn();
    renderHook(() =>
      usePolling(callback, { intervalMs: 1000, enabled: () => true }),
    );

    await vi.advanceTimersByTimeAsync(3000);

    expect(callback).toHaveBeenCalledTimes(3);
  });

  it('does not start another callback while the previous one is pending', async () => {
    const callback = vi.fn(() => new Promise<void>(() => {}));
    renderHook(() =>
      usePolling(callback, { intervalMs: 1000, enabled: () => true }),
    );

    await vi.advanceTimersByTimeAsync(3000);

    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('runs the next tick after a pending callback resolves', async () => {
    let resolveCallback: (() => void) | undefined;
    const pendingCallback = new Promise<void>((resolve) => {
      resolveCallback = resolve;
    });
    const callback = vi
      .fn()
      .mockImplementationOnce(() => pendingCallback)
      .mockResolvedValueOnce(undefined);
    renderHook(() =>
      usePolling(callback, { intervalMs: 1000, enabled: () => true }),
    );

    await vi.advanceTimersByTimeAsync(1000);
    resolveCallback?.();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);

    expect(callback).toHaveBeenCalledTimes(2);
  });

  it('runs the next tick after a callback rejects', async () => {
    const callback = vi
      .fn()
      .mockRejectedValueOnce(new Error('Request failed'))
      .mockResolvedValueOnce(undefined);
    renderHook(() =>
      usePolling(callback, { intervalMs: 1000, enabled: () => true }),
    );

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);

    expect(callback).toHaveBeenCalledTimes(2);
  });

  it('does not call the callback on a tick while disabled', async () => {
    const callback = vi.fn();
    renderHook(() =>
      usePolling(callback, { intervalMs: 1000, enabled: () => false }),
    );

    await vi.advanceTimersByTimeAsync(3000);

    expect(callback).not.toHaveBeenCalled();
  });

  it('does not call the callback on mount unless runImmediately is set', () => {
    const callback = vi.fn();
    renderHook(() =>
      usePolling(callback, { intervalMs: 1000, enabled: () => true }),
    );

    expect(callback).not.toHaveBeenCalled();
  });

  it('calls the callback once immediately when runImmediately is set', async () => {
    const callback = vi.fn();
    renderHook(() =>
      usePolling(callback, {
        intervalMs: 1000,
        enabled: () => false,
        runImmediately: true,
      }),
    );

    // Only setInterval is faked, so testing-library's own polling still works.
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('skips a tick while the document is hidden', async () => {
    const visibilitySpy = vi
      .spyOn(document, 'visibilityState', 'get')
      .mockReturnValue('hidden');
    const callback = vi.fn();
    renderHook(() =>
      usePolling(callback, { intervalMs: 1000, enabled: () => true }),
    );

    await vi.advanceTimersByTimeAsync(2000);

    expect(callback).not.toHaveBeenCalled();
    visibilitySpy.mockRestore();
  });

  it('does not evaluate enabled while the document is hidden', async () => {
    const visibilitySpy = vi
      .spyOn(document, 'visibilityState', 'get')
      .mockReturnValue('hidden');
    const enabled = vi.fn(() => true);
    renderHook(() => usePolling(() => {}, { intervalMs: 1000, enabled }));

    await vi.advanceTimersByTimeAsync(30_000);

    expect(enabled).not.toHaveBeenCalled();
    visibilitySpy.mockRestore();
  });

  it('fires immediately on a visibilitychange to visible', async () => {
    const callback = vi.fn();
    renderHook(() =>
      usePolling(callback, { intervalMs: 10_000, enabled: () => true }),
    );

    expect(callback).not.toHaveBeenCalled();
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);

    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('clears the interval and the visibilitychange listener on unmount', async () => {
    const callback = vi.fn();
    const removeListenerSpy = vi.spyOn(document, 'removeEventListener');
    const { unmount } = renderHook(() =>
      usePolling(callback, { intervalMs: 1000, enabled: () => true }),
    );

    unmount();
    await vi.advanceTimersByTimeAsync(5000);

    expect(callback).not.toHaveBeenCalled();
    expect(removeListenerSpy).toHaveBeenCalledWith(
      'visibilitychange',
      expect.any(Function),
    );
    removeListenerSpy.mockRestore();
  });

  it("the returned isMounted() reflects the hook's mounted state", () => {
    const { result, unmount } = renderHook(() =>
      usePolling(() => {}, { intervalMs: 1000, enabled: () => true }),
    );

    expect(result.current()).toBe(true);
    unmount();
    expect(result.current()).toBe(false);
  });
});
