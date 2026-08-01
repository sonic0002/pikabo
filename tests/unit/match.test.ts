import { describe, expect, it } from 'vitest';
import { deepEqual, globToRegExp, matchesPattern } from '../../src/util/match.js';

describe('globToRegExp', () => {
  it('matches a single-segment wildcard', () => {
    expect(globToRegExp('*.pdf').test('report.pdf')).toBe(true);
    expect(globToRegExp('*.pdf').test('report.txt')).toBe(false);
  });

  it('does not let * cross a path separator', () => {
    expect(globToRegExp('*.pdf').test('dir/report.pdf')).toBe(false);
  });

  it('lets ** cross separators', () => {
    expect(globToRegExp('**/report-*.csv').test('a/b/report-2024.csv')).toBe(true);
  });

  it('treats ? as a single character', () => {
    expect(globToRegExp('file?.txt').test('file1.txt')).toBe(true);
    expect(globToRegExp('file?.txt').test('file12.txt')).toBe(false);
  });

  it('escapes regex metacharacters in literals', () => {
    expect(globToRegExp('a+b.txt').test('a+b.txt')).toBe(true);
    expect(globToRegExp('a+b.txt').test('aaab.txt')).toBe(false);
  });
});

describe('matchesPattern', () => {
  it('treats /.../ as a regular expression', () => {
    expect(matchesPattern('Report 2024', '/^report/i')).toBe(true);
    expect(matchesPattern('Report 2024', '/^report$/')).toBe(false);
  });

  it('treats a pattern with metacharacters as a glob', () => {
    expect(matchesPattern('sample-report.txt', '*.txt')).toBe(true);
  });

  it('treats a plain string as a substring match', () => {
    expect(matchesPattern('https://example.com/dashboard', '/dashboard')).toBe(true);
    expect(matchesPattern('https://example.com/home', '/dashboard')).toBe(false);
  });
});

describe('deepEqual', () => {
  it('compares nested structures', () => {
    expect(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 3 }] })).toBe(false);
  });

  it('distinguishes arrays from objects', () => {
    expect(deepEqual([1, 2], { 0: 1, 1: 2 })).toBe(false);
  });

  it('requires the same key count', () => {
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });

  it('handles primitives and null', () => {
    expect(deepEqual(1, 1)).toBe(true);
    expect(deepEqual(null, null)).toBe(true);
    expect(deepEqual(null, {})).toBe(false);
    expect(deepEqual(undefined, null)).toBe(false);
  });
});
