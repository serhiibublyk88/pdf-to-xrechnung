import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import { ExtractionModeController } from './extraction-mode.controller';

async function controllerFor(
  provider: string,
): Promise<ExtractionModeController> {
  const module = await Test.createTestingModule({
    controllers: [ExtractionModeController],
    providers: [{ provide: ConfigService, useValue: { get: () => provider } }],
  })
    .overrideGuard(ThrottlerGuard)
    .useValue({ canActivate: () => true })
    .compile();
  return module.get(ExtractionModeController);
}

describe('ExtractionModeController', () => {
  it('reports demo mode for the mock provider', async () => {
    const controller = await controllerFor('mock');

    expect(controller.mode()).toEqual({ demo: true });
  });

  it('reports live extraction for a real provider', async () => {
    const controller = await controllerFor('gemini');

    expect(controller.mode()).toEqual({ demo: false });
  });
});
