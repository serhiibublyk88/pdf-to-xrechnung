'use client';

import { useCallback, useEffect, useReducer, useRef } from 'react';
import { getInvoiceReview, getInvoiceStatus } from '@/lib/api/client';
import type { ApiError, ApiResult } from '@/lib/api/errors';
import { terminalStatuses } from '@/lib/api/schemas';
import type {
  InvoiceDetail,
  InvoiceStatusResult,
  ReviewResult,
} from '@/lib/api/schemas';
import { POLL_INTERVAL_MS, usePolling } from '@/lib/polling/use-polling';
import { diffDraft, toDraft, type InvoiceDraft } from './draft';

const RETRY_POLL_ATTEMPTS_LIMIT = 10;

type SubmitResult = 'GENERATING' | 'NEEDS_REVIEW';

interface ReviewState {
  invoiceId: string | null;
  status: InvoiceStatusResult | null;
  detail: InvoiceDetail | null;
  draft: InvoiceDraft | null;
  originalDraft: InvoiceDraft | null;
  notFound: boolean;
  loadError: ApiError | null;
  lineItemsRestructured: boolean;
  vatBreakdownRestructured: boolean;
  retryGaveUp: boolean;
  submitResult: SubmitResult | null;
}

type DetailRefreshMode = 'preserveDraft' | 'replaceDraft';

type ReviewAction =
  | { type: 'reset'; invoiceId: string }
  | {
      type: 'initialLoaded';
      status: ApiResult<InvoiceStatusResult>;
      detail: ApiResult<InvoiceDetail>;
    }
  | {
      type: 'statusRefreshed';
      status: InvoiceStatusResult;
      transitioned: boolean;
    }
  | {
      type: 'detailRefreshed';
      detail: InvoiceDetail;
      mode: DetailRefreshMode;
    }
  | { type: 'loadFailed'; error: ApiError }
  | { type: 'notFound' }
  | { type: 'conflictDetected' }
  | { type: 'draftEdited'; edit: (draft: InvoiceDraft) => InvoiceDraft }
  | {
      type: 'draftRestructured';
      collection: 'lineItems' | 'vatBreakdown';
      edit: (draft: InvoiceDraft) => InvoiceDraft;
    }
  | { type: 'retryStarted' }
  | { type: 'retryGaveUp' }
  | { type: 'submitted'; result: ReviewResult };

const initialState: ReviewState = {
  invoiceId: null,
  status: null,
  detail: null,
  draft: null,
  originalDraft: null,
  notFound: false,
  loadError: null,
  lineItemsRestructured: false,
  vatBreakdownRestructured: false,
  retryGaveUp: false,
  submitResult: null,
};

function applyDetail(
  state: ReviewState,
  detail: InvoiceDetail,
  mode: DetailRefreshMode,
): ReviewState {
  const refreshed = { ...state, detail };
  if (!detail.extractedData) {
    return refreshed;
  }

  const nextDraft = toDraft(detail.extractedData);
  const hasUnsavedEdits =
    state.draft !== null &&
    state.originalDraft !== null &&
    diffDraft(state.originalDraft, state.draft).length > 0;
  if (mode === 'preserveDraft' && hasUnsavedEdits) {
    return { ...refreshed, originalDraft: nextDraft };
  }

  return {
    ...refreshed,
    draft: nextDraft,
    originalDraft: nextDraft,
    lineItemsRestructured: false,
    vatBreakdownRestructured: false,
  };
}

function applyLoadResult<T>(
  state: ReviewState,
  result: ApiResult<T>,
  onSuccess: (state: ReviewState, data: T) => ReviewState,
): ReviewState {
  if (result.ok) return onSuccess(state, result.data);
  if (result.error.kind === 'not_found') return { ...state, notFound: true };
  return { ...state, loadError: result.error };
}

function reviewReducer(state: ReviewState, action: ReviewAction): ReviewState {
  switch (action.type) {
    case 'reset':
      return { ...initialState, invoiceId: action.invoiceId };

    case 'initialLoaded': {
      const cleared = { ...state, notFound: false, loadError: null };
      const withStatus = applyLoadResult(
        cleared,
        action.status,
        (next, status) => ({
          ...next,
          status,
        }),
      );
      return applyLoadResult(withStatus, action.detail, (next, detail) =>
        applyDetail(next, detail, 'replaceDraft'),
      );
    }

    case 'statusRefreshed':
      return {
        ...state,
        status: action.status,
        loadError: null,
        ...(action.transitioned
          ? { retryGaveUp: false, submitResult: null }
          : {}),
      };

    case 'detailRefreshed':
      return applyDetail(
        { ...state, loadError: null },
        action.detail,
        action.mode,
      );

    case 'loadFailed':
      return { ...state, loadError: action.error };

    case 'notFound':
      return { ...state, notFound: true };

    case 'conflictDetected':
      return {
        ...state,
        submitResult: null,
        detail: state.detail
          ? { ...state.detail, lifecycleToken: null }
          : state.detail,
      };

    case 'draftEdited':
      return state.draft === null
        ? state
        : { ...state, draft: action.edit(state.draft) };

    case 'draftRestructured':
      return state.draft === null
        ? state
        : {
            ...state,
            draft: action.edit(state.draft),
            ...(action.collection === 'lineItems'
              ? { lineItemsRestructured: true }
              : { vatBreakdownRestructured: true }),
          };

    case 'retryStarted':
      return { ...state, retryGaveUp: false };

    case 'retryGaveUp':
      return { ...state, retryGaveUp: true };

    case 'submitted':
      return {
        ...state,
        loadError: null,
        submitResult: action.result.status,
        originalDraft: state.draft,
        lineItemsRestructured: false,
        vatBreakdownRestructured: false,
        status: state.status
          ? { ...state.status, status: action.result.status }
          : state.status,
        detail: state.detail
          ? {
              ...state.detail,
              status: action.result.status,
              lifecycleToken: action.result.lifecycleToken,
              findings: [],
            }
          : state.detail,
      };
  }
}

export interface InvoiceReview extends ReviewState {
  isCurrent: () => boolean;
  editDraft: (edit: (draft: InvoiceDraft) => InvoiceDraft) => void;
  restructureDraft: (
    collection: 'lineItems' | 'vatBreakdown',
    edit: (draft: InvoiceDraft) => InvoiceDraft,
  ) => void;
  reload: () => Promise<void>;
  replaceDetail: () => Promise<void>;
  onConflict: () => void;
  onRetried: () => void;
  onSubmitted: (result: ReviewResult) => void;
}

interface RequestScope {
  invoiceId: string;
  active: boolean;
  statusVersion: number;
  detailVersion: number;
  retryPollOverride: boolean;
  retryPollAttempts: number;
}

function newRequestScope(invoiceId: string): RequestScope {
  return {
    invoiceId,
    active: false,
    statusVersion: 0,
    detailVersion: 0,
    retryPollOverride: false,
    retryPollAttempts: 0,
  };
}

export function useInvoiceReview(invoiceId: string): InvoiceReview {
  const [state, dispatch] = useReducer(reviewReducer, initialState);
  const scopeRef = useRef<RequestScope>(newRequestScope(invoiceId));

  function shouldPoll(): boolean {
    return (
      !state.notFound &&
      (scopeRef.current.retryPollOverride ||
        state.status === null ||
        !terminalStatuses.has(state.status.status) ||
        (state.detail !== null && state.detail.status !== state.status.status))
    );
  }

  const isMounted = usePolling(refreshStatus, {
    intervalMs: POLL_INTERVAL_MS,
    enabled: shouldPoll,
  });

  const loadDetail = useCallback(
    async (mode: DetailRefreshMode): Promise<void> => {
      const scope = scopeRef.current;
      const version = ++scope.detailVersion;
      const review = await getInvoiceReview(invoiceId);
      if (
        !isMounted() ||
        !scope.active ||
        scope.invoiceId !== invoiceId ||
        version !== scope.detailVersion
      )
        return;
      if (review.ok)
        dispatch({ type: 'detailRefreshed', detail: review.data, mode });
      else if (review.error.kind === 'not_found')
        dispatch({ type: 'notFound' });
      else dispatch({ type: 'loadFailed', error: review.error });
    },
    [invoiceId, isMounted],
  );

  const replaceDetail = useCallback(
    (): Promise<void> => loadDetail('replaceDraft'),
    [loadDetail],
  );

  const reload = useCallback(async (): Promise<void> => {
    const scope = scopeRef.current;
    const statusVersion = ++scope.statusVersion;
    const detailVersion = ++scope.detailVersion;
    const [status, detail] = await Promise.all([
      getInvoiceStatus(invoiceId),
      getInvoiceReview(invoiceId),
    ]);
    if (
      !isMounted() ||
      !scope.active ||
      scope.invoiceId !== invoiceId ||
      statusVersion !== scope.statusVersion ||
      detailVersion !== scope.detailVersion
    )
      return;
    dispatch({ type: 'initialLoaded', status, detail });
    if (status.ok && detail.ok && status.data.status !== detail.data.status)
      await loadDetail('preserveDraft');
  }, [invoiceId, isMounted, loadDetail]);

  async function refreshStatus(): Promise<void> {
    const scope = scopeRef.current;
    const version = ++scope.statusVersion;
    const retryPoll = scope.retryPollOverride;
    if (retryPoll) scope.retryPollAttempts += 1;
    const result = await getInvoiceStatus(invoiceId);
    if (
      !isMounted() ||
      !scope.active ||
      scope.invoiceId !== invoiceId ||
      version !== scope.statusVersion
    )
      return;
    if (result.ok) {
      const transitioned =
        state.status !== null && state.status.status !== result.data.status;
      if (transitioned) {
        scope.retryPollOverride = false;
        scope.retryPollAttempts = 0;
      }
      dispatch({ type: 'statusRefreshed', status: result.data, transitioned });
      if (state.detail === null || state.detail.status !== result.data.status)
        await loadDetail('preserveDraft');
    } else if (result.error.kind === 'not_found') {
      dispatch({ type: 'notFound' });
    } else {
      dispatch({ type: 'loadFailed', error: result.error });
    }

    if (
      retryPoll &&
      scope.retryPollOverride &&
      scope.retryPollAttempts >= RETRY_POLL_ATTEMPTS_LIMIT
    ) {
      scope.retryPollOverride = false;
      dispatch({ type: 'retryGaveUp' });
    }
  }

  useEffect(() => {
    // GET /review fans out to Redis queues; poll only status.
    const previous = scopeRef.current;
    if (previous.invoiceId !== invoiceId) {
      previous.active = false;
      scopeRef.current = newRequestScope(invoiceId);
    }
    const scope = scopeRef.current;
    scope.active = true;
    dispatch({ type: 'reset', invoiceId });
    void reload();
    return () => {
      scope.active = false;
    };
  }, [invoiceId, reload]);

  const currentState =
    state.invoiceId === invoiceId ? state : { ...initialState, invoiceId };
  const isCurrent = () =>
    isMounted() &&
    scopeRef.current.active &&
    scopeRef.current.invoiceId === invoiceId;

  return {
    ...currentState,
    isCurrent,
    editDraft: (edit) => dispatch({ type: 'draftEdited', edit }),
    restructureDraft: (collection, edit) =>
      dispatch({ type: 'draftRestructured', collection, edit }),
    reload,
    replaceDetail,
    onConflict: () => {
      if (!isCurrent()) return;
      scopeRef.current.statusVersion += 1;
      dispatch({ type: 'conflictDetected' });
    },
    onRetried: () => {
      if (!isCurrent()) return;
      scopeRef.current.retryPollOverride = true;
      scopeRef.current.retryPollAttempts = 0;
      dispatch({ type: 'retryStarted' });
      void refreshStatus();
      void loadDetail('preserveDraft');
    },
    onSubmitted: (result) => {
      if (!isCurrent()) return;
      scopeRef.current.statusVersion += 1;
      scopeRef.current.detailVersion += 1;
      dispatch({ type: 'submitted', result });
    },
  };
}
