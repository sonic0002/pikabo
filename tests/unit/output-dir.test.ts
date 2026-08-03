import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareOutputDir } from '../../src/run.js';

const created: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ext-out-'));
  created.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const MARKER = '.ext-test-results';

describe('prepareOutputDir', () => {
  it('creates a missing directory and claims it', () => {
    const parent = scratch();
    const dir = join(parent, 'results');
    const result = prepareOutputDir(dir);
    expect(result.cleaned).toBe(false);
    expect(existsSync(join(dir, MARKER))).toBe(true);
  });

  it('claims an existing empty directory without reporting a clean', () => {
    const dir = scratch();
    const result = prepareOutputDir(dir);
    expect(result.cleaned).toBe(false);
    expect(result.warning).toBeUndefined();
    expect(existsSync(join(dir, MARKER))).toBe(true);
  });

  it('clears artefacts it owns on the next run', () => {
    const dir = scratch();
    prepareOutputDir(dir);
    mkdirSync(join(dir, 'screenshots', 'old-suite', 'old-test'), { recursive: true });
    writeFileSync(join(dir, 'screenshots', 'old-suite', 'old-test', '0-openPopup.png'), 'x');
    writeFileSync(join(dir, 'results.json'), '{}');

    const result = prepareOutputDir(dir);
    expect(result.cleaned).toBe(true);
    // A renamed or deleted test must not leave a directory behind pretending to be current.
    expect(existsSync(join(dir, 'screenshots'))).toBe(false);
    expect(existsSync(join(dir, 'results.json'))).toBe(false);
    expect(existsSync(join(dir, MARKER))).toBe(true);
  });

  it('keeps everything when cleaning is disabled', () => {
    const dir = scratch();
    prepareOutputDir(dir);
    mkdirSync(join(dir, 'screenshots'), { recursive: true });
    writeFileSync(join(dir, 'screenshots', 'stale.png'), 'x');

    const result = prepareOutputDir(dir, false);
    expect(result.cleaned).toBe(false);
    expect(existsSync(join(dir, 'screenshots', 'stale.png'))).toBe(true);
  });

  it('refuses to clear a directory it did not create', () => {
    const dir = scratch();
    writeFileSync(join(dir, 'important.txt'), 'do not delete me');

    const result = prepareOutputDir(dir);
    expect(result.cleaned).toBe(false);
    expect(result.warning).toMatch(/does not recognise/);
    expect(result.warning).toMatch(/important\.txt/);
    expect(existsSync(join(dir, 'important.txt'))).toBe(true);
    // It must not claim ownership either, or the next run would wipe the user's files.
    expect(existsSync(join(dir, MARKER))).toBe(false);
  });

  it('never claims a directory holding unrelated files, even across repeated runs', () => {
    const dir = scratch();
    writeFileSync(join(dir, 'important.txt'), 'keep');
    for (let i = 0; i < 3; i++) prepareOutputDir(dir);
    expect(readdirSync(dir)).toEqual(['important.txt']);
  });

  it('adopts a directory written by an older version that has no marker', () => {
    // Before the marker existed, ext-tester still wrote exactly these files. Refusing to clean
    // them forever — and telling the user the directory was not created by ext-tester — is worse
    // than having no guard, because it never resolves itself.
    const dir = scratch();
    mkdirSync(join(dir, 'screenshots', 'old-suite', 'deleted-test'), { recursive: true });
    writeFileSync(join(dir, 'screenshots', 'old-suite', 'deleted-test', '0-openPopup.png'), 'x');
    writeFileSync(join(dir, 'results.json'), '{}');
    writeFileSync(join(dir, 'report.html'), '<html>');
    writeFileSync(join(dir, 'summary.md'), '#');

    const result = prepareOutputDir(dir);
    expect(result.cleaned).toBe(true);
    expect(result.warning).toBeUndefined();
    expect(existsSync(join(dir, 'screenshots'))).toBe(false);
    expect(existsSync(join(dir, MARKER))).toBe(true);
  });

  it('names the unrecognised files so the user can act on the warning', () => {
    const dir = scratch();
    writeFileSync(join(dir, 'results.json'), '{}');
    writeFileSync(join(dir, 'notes.md'), 'mine');

    const result = prepareOutputDir(dir);
    expect(result.cleaned).toBe(false);
    expect(result.warning).toMatch(/notes\.md/);
    // One unrecognised file protects the whole directory, artefacts included.
    expect(existsSync(join(dir, 'results.json'))).toBe(true);
  });

  it('does not report a clean when there was nothing to remove', () => {
    const dir = scratch();
    prepareOutputDir(dir);
    expect(prepareOutputDir(dir).cleaned).toBe(false);
  });
});
