import { createHash } from 'node:crypto';

/**
 * Compute the extension ID Chrome assigns to an unpacked extension loaded from `absPath`.
 *
 * Chrome derives it from the path rather than from a key: SHA-256 the absolute path, take the
 * first 16 bytes, hex-encode them, then map each hex digit onto the alphabet a–p. On Windows
 * the path is hashed as UTF-16LE; elsewhere as UTF-8.
 *
 * This is the fallback when an extension has no service worker to read the ID from, which is the
 * case for content-script-only and Manifest V2 extensions.
 */
export function computeUnpackedExtensionId(absPath: string, platform = process.platform): string {
  const encoding = platform === 'win32' ? 'utf16le' : 'utf8';
  const digest = createHash('sha256').update(Buffer.from(absPath, encoding)).digest('hex');
  return hexToExtensionAlphabet(digest.slice(0, 32));
}

/** Map hex digits 0–f onto a–p, the alphabet Chrome uses for extension IDs. */
export function hexToExtensionAlphabet(hex: string): string {
  let out = '';
  for (const ch of hex) {
    const value = parseInt(ch, 16);
    if (Number.isNaN(value)) throw new Error(`Not a hex string: ${hex}`);
    out += String.fromCharCode('a'.charCodeAt(0) + value);
  }
  return out;
}

/** Extract the extension ID from any `chrome-extension://<id>/...` URL. */
export function extensionIdFromUrl(url: string): string | undefined {
  const match = /^chrome-extension:\/\/([a-p]{32})\b/.exec(url);
  return match?.[1];
}

export function isValidExtensionId(id: string): boolean {
  return /^[a-p]{32}$/.test(id);
}
