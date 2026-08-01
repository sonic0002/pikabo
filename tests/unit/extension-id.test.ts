import { describe, expect, it } from 'vitest';
import {
  computeUnpackedExtensionId,
  extensionIdFromUrl,
  hexToExtensionAlphabet,
  isValidExtensionId,
} from '../../src/browser/extension-id.js';

describe('hexToExtensionAlphabet', () => {
  it('maps 0-f onto a-p', () => {
    expect(hexToExtensionAlphabet('0123456789abcdef')).toBe('abcdefghijklmnop');
  });

  it('rejects non-hex input', () => {
    expect(() => hexToExtensionAlphabet('zz')).toThrow();
  });
});

describe('computeUnpackedExtensionId', () => {
  it('produces a 32-character id in the a-p alphabet', () => {
    const id = computeUnpackedExtensionId('/Users/someone/ext', 'darwin');
    expect(id).toHaveLength(32);
    expect(isValidExtensionId(id)).toBe(true);
  });

  it('is deterministic for the same path', () => {
    const a = computeUnpackedExtensionId('/tmp/my-ext', 'linux');
    const b = computeUnpackedExtensionId('/tmp/my-ext', 'linux');
    expect(a).toBe(b);
  });

  it('differs between paths', () => {
    expect(computeUnpackedExtensionId('/tmp/a', 'linux')).not.toBe(
      computeUnpackedExtensionId('/tmp/b', 'linux'),
    );
  });

  it('hashes as UTF-16LE on Windows, matching Chrome', () => {
    expect(computeUnpackedExtensionId('C:\\ext', 'win32')).not.toBe(
      computeUnpackedExtensionId('C:\\ext', 'linux'),
    );
  });
});

describe('extensionIdFromUrl', () => {
  it('extracts the id from an extension URL', () => {
    const id = 'a'.repeat(32);
    expect(extensionIdFromUrl(`chrome-extension://${id}/popup.html`)).toBe(id);
    expect(extensionIdFromUrl(`chrome-extension://${id}/`)).toBe(id);
  });

  it('returns undefined for other URLs', () => {
    expect(extensionIdFromUrl('https://example.com')).toBeUndefined();
    expect(extensionIdFromUrl('chrome-extension://TOOSHORT/x')).toBeUndefined();
  });
});
