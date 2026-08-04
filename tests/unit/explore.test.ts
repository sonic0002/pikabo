import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateSmokeSuite, matchPatternToUrl, suiteToYaml } from '../../src/explore/generate.js';
import { parseSuite } from '../../src/dsl/parse.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures');

describe('matchPatternToUrl', () => {
  it('resolves a host pattern to a concrete URL', () => {
    expect(matchPatternToUrl('*://*.example.com/*')).toBe('https://example.com/');
    expect(matchPatternToUrl('https://github.com/*')).toBe('https://github.com/');
  });

  it('keeps a meaningful path prefix', () => {
    expect(matchPatternToUrl('https://example.com/docs/*')).toBe('https://example.com/docs/');
  });

  it('falls back to the sample URL for broad patterns', () => {
    expect(matchPatternToUrl('<all_urls>', 'https://sample.test/')).toBe('https://sample.test/');
    expect(matchPatternToUrl('*://*/*', 'https://sample.test/')).toBe('https://sample.test/');
  });

  it('skips schemes a test cannot drive', () => {
    expect(matchPatternToUrl('file:///*')).toBeUndefined();
  });
});

describe('generateSmokeSuite', () => {
  it('derives a test per surface the manifest declares', () => {
    const suite = generateSmokeSuite(join(fixtures, 'sample-extension'));
    const names = suite.tests.map((t) => t.name);
    expect(names).toContain('service worker starts without errors');
    expect(names).toContain('popup renders');
    expect(names).toContain('options page renders');
    expect(names.some((n) => n.includes('content script'))).toBe(true);
    const contentTest = suite.tests.find((test) => test.name.includes('content script'))!;
    expect(contentTest.steps).toContainEqual({
      waitForExtensionEvent: expect.objectContaining({
        type: 'contentScript.executed',
        contains: expect.objectContaining({ file: 'content.js' }),
      }),
    });
  });

  it('omits surfaces the manifest does not declare', () => {
    const suite = generateSmokeSuite(join(fixtures, 'broken-extension'));
    const names = suite.tests.map((t) => t.name);
    expect(names).toContain('popup renders');
    expect(names).not.toContain('options page renders');
    expect(names.some((n) => n.includes('content script'))).toBe(false);
  });

  it('produces a suite that survives a round trip through the parser', () => {
    const suite = generateSmokeSuite(join(fixtures, 'sample-extension'));
    const yaml = suiteToYaml(suite);
    const reparsed = parseSuite(yaml, 'smoke.generated.yaml');
    expect(reparsed.tests.map((t) => t.name)).toEqual(suite.tests.map((t) => t.name));
  });

  it('names the generated suite after the extension', () => {
    const suite = generateSmokeSuite(join(fixtures, 'sample-extension'));
    expect(suite.name).toBe('pikabo sample smoke tests');
  });
});
