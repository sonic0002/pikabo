import { describe, expect, it } from 'vitest';
import { selectTests, validateRunOptions, validateTestSelection } from '../../src/dsl/runner.js';
import type { Suite } from '../../src/types.js';

const suite: Suite = {
  name: 'functional tests',
  tests: [
    { name: 'popup saves a PDF', steps: [] },
    { name: 'options save the theme', steps: [] },
    { name: 'popup saves an image', steps: [] },
  ],
};

describe('test selection', () => {
  it('selects an exact test name and skips the others', () => {
    const selected = selectTests(suite, undefined, 'popup saves a PDF');
    expect(selected.map((test) => [test.name, Boolean(test.skip)])).toEqual([
      ['popup saves a PDF', false],
      ['options save the theme', true],
      ['popup saves an image', true],
    ]);
  });

  it('keeps substring matching for --grep', () => {
    const selected = selectTests(suite, 'popup');
    expect(selected.filter((test) => !test.skip).map((test) => test.name)).toEqual([
      'popup saves a PDF',
      'popup saves an image',
    ]);
  });

  it('rejects a missing exact name and lists available tests', () => {
    expect(() =>
      validateTestSelection([{ suite, file: '/tests/functional.yaml' }], { testName: 'missing test' }),
    ).toThrowError(/No test named "missing test"[\s\S]*popup saves a PDF/);
  });

  it('rejects combining exact and pattern selection', () => {
    expect(() =>
      validateTestSelection([{ suite, file: '/tests/functional.yaml' }], {
        testName: 'popup saves a PDF',
        grep: 'popup',
      }),
    ).toThrowError(/either --test or --grep/);
  });
});

describe('run options', () => {
  it('rejects an unknown isolation mode before launching a browser', () => {
    expect(() => validateRunOptions({ isolation: 'shared' as 'fresh-profile' })).toThrowError(
      /fresh-profile.*reset/,
    );
  });
});
