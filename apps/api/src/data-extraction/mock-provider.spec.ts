import type { LlmProvider } from './llm-provider.interface';
import { MockProvider } from './mock-provider';
import { RawExtractedInvoiceDataSchema } from '@pdf-to-xrechnung/contracts';
import { isEmptyExtraction } from './empty-extraction';

describe('MockProvider', () => {
  it('identifies itself', () => {
    const provider = new MockProvider();
    expect(provider.name).toBe('mock');
    expect(provider.model).toBe('mock-v1');
  });

  it('returns a schema-valid, non-empty response regardless of input', async () => {
    const provider: LlmProvider = new MockProvider();
    const response = await provider.extract('anything');

    const parsed: unknown = JSON.parse(response.text);
    const validated = RawExtractedInvoiceDataSchema.safeParse(parsed);
    expect(validated.success).toBe(true);
    if (validated.success) {
      expect(isEmptyExtraction(validated.data)).toBe(false);
    }
  });

  it('returns the same fixture regardless of the prompt given', async () => {
    const provider: LlmProvider = new MockProvider();
    const first = await provider.extract('prompt A');
    const second = await provider.extract('an entirely different prompt B');
    expect(first.text).toBe(second.text);
  });
});
