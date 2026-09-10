import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DictionaryProvider } from '@/lib/i18n/dictionary-context';
import { PipelineStepper } from './pipeline-stepper';
import { resolvePipeline } from '@/lib/pipeline/stages';

function renderStepper(pipeline: ReturnType<typeof resolvePipeline>) {
  return render(
    <DictionaryProvider locale="de">
      <PipelineStepper pipeline={pipeline} />
    </DictionaryProvider>,
  );
}

describe('PipelineStepper', () => {
  it('carries the single aria-live region the design calls for', () => {
    renderStepper(resolvePipeline({ status: 'EXTRACTING_TEXT' }));
    const region = screen.getByRole('status');
    expect(region.getAttribute('aria-live')).toBe('polite');
  });

  it('names a pending stage neutrally rather than claiming it is done', () => {
    renderStepper(resolvePipeline({ status: 'EXTRACTING_TEXT' }));

    expect(screen.queryByText('Daten erkannt')).toBeNull();
    expect(screen.getByText('Datenextraktion')).toBeTruthy();
  });

  it('names a failed stage neutrally rather than claiming it is done', () => {
    renderStepper(
      resolvePipeline({
        status: 'FAILED',
        failure: { code: 'llm_provider_error' },
      }),
    );

    expect(screen.queryByText('Daten erkannt')).toBeNull();
    expect(screen.getByText('Datenextraktion')).toBeTruthy();
  });

  it('still shows the done-tense label for a genuinely completed stage', () => {
    renderStepper(resolvePipeline({ status: 'READY' }));

    expect(screen.getByText('Text gelesen')).toBeTruthy();
    expect(screen.getByText('Daten erkannt')).toBeTruthy();
  });

  it('shows the active-tense label for the stage in progress', () => {
    renderStepper(resolvePipeline({ status: 'EXTRACTING_DATA' }));

    expect(screen.getByText('Daten werden erkannt')).toBeTruthy();
  });

  it('keeps the done-tense label for a stopped stage', () => {
    renderStepper(
      resolvePipeline({
        status: 'NEEDS_REVIEW',
        findings: [
          {
            rule: 'arithmetic.gross',
            field: 'grossTotal',
            severity: 'ERROR',
            passed: false,
            message: 'message',
            expected: null,
            actual: null,
          },
        ],
      }),
    );

    expect(screen.getByText('Geprüft')).toBeTruthy();
  });
});
