import { describe, expect, it, vi } from 'vitest';
import { createExtensionTest } from '../../src/playwright.js';

describe('createExtensionTest', () => {
  it('extends the caller’s Playwright test with extension-aware fixtures and options', () => {
    const extended = Symbol('extended');
    const extend = vi.fn(() => extended);
    const result = createExtensionTest({ extend } as never);
    expect(result).toBe(extended);
    const fixtures = extend.mock.calls[0]![0] as Record<string, unknown>;
    expect(Object.keys(fixtures)).toEqual(
      expect.arrayContaining([
        'extensionPath',
        'extensionSession',
        'extensionContext',
        'extensionPage',
        'extensionWorker',
        'extensionPopup',
        'extensionOptions',
        'extensionSidePanel',
        'extensionTrace',
      ]),
    );
  });
});
