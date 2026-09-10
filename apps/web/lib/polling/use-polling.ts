'use client';

import { useCallback, useEffect, useRef } from 'react';

export const POLL_INTERVAL_MS = 3000;

export function usePolling(
  callback: () => void | Promise<void>,
  {
    intervalMs,
    enabled,
    runImmediately = false,
  }: { intervalMs: number; enabled: () => boolean; runImmediately?: boolean },
): () => boolean {
  const callbackRef = useRef(callback);
  const enabledRef = useRef(enabled);
  useEffect(() => {
    callbackRef.current = callback;
    enabledRef.current = enabled;
  });

  const mountedRef = useRef(true);
  const requestInFlightRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;

    function runCallback() {
      if (requestInFlightRef.current) return;

      requestInFlightRef.current = true;
      void Promise.resolve(callbackRef.current())
        .catch(() => undefined)
        .finally(() => {
          requestInFlightRef.current = false;
        });
    }

    function tick() {
      if (document.visibilityState === 'hidden') return;
      if (enabledRef.current()) runCallback();
    }

    const immediateTimeout = runImmediately
      ? setTimeout(runCallback, 0)
      : undefined;
    const interval = setInterval(tick, intervalMs);

    function handleVisibilityChange() {
      if (document.visibilityState === 'hidden') return;
      if (enabledRef.current()) runCallback();
    }
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      mountedRef.current = false;
      if (immediateTimeout !== undefined) clearTimeout(immediateTimeout);
      clearInterval(interval);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [intervalMs, runImmediately]);

  return useCallback(() => mountedRef.current, []);
}
