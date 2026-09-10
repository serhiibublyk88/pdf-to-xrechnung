import type {
  LlmProvider,
  RawLlmResponse,
} from '../src/data-extraction/llm-provider.interface';
import type { GoldenFixture } from './golden-fixture.schema';

export class DatasetProvider implements LlmProvider {
  readonly name = 'eval-dataset';
  readonly model = 'dataset-v1';
  private fixture: GoldenFixture | null = null;
  calls = 0;

  use(fixture: GoldenFixture): void {
    this.fixture = fixture;
    this.calls = 0;
  }

  clear(): void {
    this.fixture = null;
  }

  extract(): Promise<RawLlmResponse> {
    if (!this.fixture) {
      throw new Error(
        'DatasetProvider has no fixture for the current evaluation case',
      );
    }
    this.calls += 1;
    return Promise.resolve({
      text: JSON.stringify(this.fixture.data),
      inputTokens: null,
      outputTokens: null,
      truncated: false,
    });
  }
}
