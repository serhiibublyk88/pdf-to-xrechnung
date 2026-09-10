import { SourceType } from '@prisma/client';

export type MetricSource = 'native' | 'ocr' | 'unknown';

export function metricSource(sourceType: SourceType): MetricSource {
  if (sourceType === SourceType.NATIVE) return 'native';
  if (sourceType === SourceType.OCR) return 'ocr';
  return 'unknown';
}
