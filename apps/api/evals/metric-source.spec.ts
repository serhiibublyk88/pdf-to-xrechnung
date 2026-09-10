import { SourceType } from '@prisma/client';
import { metricSource } from './metric-source';

describe('metricSource', () => {
  it('keeps UNKNOWN results in an explicit metric bucket', () => {
    expect(metricSource(SourceType.UNKNOWN)).toBe('unknown');
  });
});
