import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extensionArgs, QUIET_ARGS } from '../../src/browser/launcher.js';
import { hasServiceWorker, ManifestError, optionsPath, popupPath, readManifest } from '../../src/browser/manifest.js';
import { compileScript } from '../../src/browser/session.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures');

describe('extensionArgs', () => {
  it('passes both load switches and the feature flag that re-enables them', () => {
    const args = extensionArgs('fixtures/sample-extension');
    const abs = resolve('fixtures/sample-extension');
    expect(args).toContain(`--load-extension=${abs}`);
    expect(args).toContain(`--disable-extensions-except=${abs}`);
    expect(args).toContain('--disable-features=DisableLoadExtensionCommandLineSwitch');
  });

  it('always uses an absolute path, since Chrome derives the extension id from it', () => {
    for (const arg of extensionArgs('./fixtures/sample-extension')) {
      const value = arg.split('=')[1];
      if (value && !arg.includes('disable-features')) expect(value.startsWith('/')).toBe(true);
    }
  });

  it('keeps first-run interruptions out of the way', () => {
    expect(QUIET_ARGS).toContain('--no-first-run');
    expect(QUIET_ARGS).toContain('--disable-search-engine-choice-screen');
  });
});

describe('readManifest', () => {
  it('reads the sample fixture', () => {
    const manifest = readManifest(join(fixtures, 'sample-extension'));
    expect(manifest.name).toBe('ext-tester sample');
    expect(popupPath(manifest)).toBe('popup.html');
    expect(optionsPath(manifest)).toBe('options.html');
    expect(hasServiceWorker(manifest)).toBe(true);
  });

  it('explains a missing manifest rather than throwing ENOENT', () => {
    // A directory created here, not one that happens to exist in the tree: git does not track
    // empty directories, so relying on one would fail in every fresh clone.
    const empty = mkdtempSync(join(tmpdir(), 'ext-no-manifest-'));
    try {
      expect(() => readManifest(empty)).toThrowError(ManifestError);
      try {
        readManifest(empty);
      } catch (err) {
        expect((err as Error).message).toMatch(/No manifest.json/);
      }
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('explains a missing directory', () => {
    expect(() => readManifest(join(fixtures, 'nope'))).toThrowError(/not found/);
  });

  it('finds a popup declared under browser_action (MV2)', () => {
    expect(popupPath({ browser_action: { default_popup: 'p.html' } })).toBe('p.html');
    expect(popupPath({ page_action: { default_popup: 'q.html' } })).toBe('q.html');
  });

  it('prefers options_ui.page over options_page', () => {
    expect(optionsPath({ options_ui: { page: 'a.html' }, options_page: 'b.html' })).toBe('a.html');
  });
});

describe('compileScript', () => {
  it('wraps a bare expression', async () => {
    expect(await compileScript('1 + 1')(undefined)).toBe(2);
  });

  it('runs a statement body that returns', async () => {
    expect(await compileScript('const x = 20; return x + 1;')(undefined)).toBe(21);
  });

  it('passes args through', async () => {
    expect(await compileScript('args.a + args.b')({ a: 2, b: 3 })).toBe(5);
  });

  it('supports await in the body', async () => {
    expect(await compileScript('const v = await Promise.resolve(9); return v;')(undefined)).toBe(9);
  });

  it('reports a syntax error against the script the user wrote', () => {
    expect(() => compileScript('const = ;')).toThrowError(/not valid JavaScript/);
  });
});
