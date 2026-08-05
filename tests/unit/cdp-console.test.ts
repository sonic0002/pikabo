import { afterEach, describe, expect, it } from 'vitest';
import { attachWorkerConsole } from '../../src/browser/cdp-console.js';

/**
 * Service-worker console capture is the reason the tool exists, so a runtime that cannot provide
 * it must say so. Node 20 and 21 have no global WebSocket, and silently returning "no console"
 * there made a passing run look like an extension with no startup errors.
 */
describe('attachWorkerConsole on a runtime with no WebSocket', () => {
  const original = globalThis.WebSocket;

  afterEach(() => {
    globalThis.WebSocket = original;
  });

  it('fails loudly rather than silently disabling worker console capture', async () => {
    // @ts-expect-error — simulating Node < 22, where the global is absent
    delete globalThis.WebSocket;

    await expect(attachWorkerConsole('/nonexistent-profile', () => {})).rejects.toThrow(
      /WebSocket/,
    );
  });
});
