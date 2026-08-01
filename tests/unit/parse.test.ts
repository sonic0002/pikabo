import { describe, expect, it } from 'vitest';
import { parseSuite, readStep, SuiteParseError } from '../../src/dsl/parse.js';

describe('parseSuite', () => {
  it('parses a suite with explicit tests', () => {
    const suite = parseSuite(`
name: Popup
tests:
  - name: opens
    steps:
      - openPopup
      - click: "#save"
`);
    expect(suite.name).toBe('Popup');
    expect(suite.tests).toHaveLength(1);
    expect(suite.tests[0]!.steps).toEqual([{ openPopup: null }, { click: '#save' }]);
  });

  it('treats top-level steps as a single test', () => {
    const suite = parseSuite(`
name: Smoke
steps:
  - navigate: https://example.com
`, '/x/smoke.yaml');
    expect(suite.tests).toHaveLength(1);
    expect(suite.tests[0]!.name).toBe('Smoke');
    expect(suite.tests[0]!.steps[0]).toEqual({ navigate: 'https://example.com' });
  });

  it('defaults the suite name to the filename', () => {
    const suite = parseSuite(`steps: [{ openPopup: null }]`, '/tests/popup-smoke.yaml');
    expect(suite.name).toBe('popup-smoke');
  });

  it('accepts a mapping of test name to steps', () => {
    const suite = parseSuite(`
tests:
  "saves a file":
    - openPopup
    - click: "#save"
`);
    expect(suite.tests[0]!.name).toBe('saves a file');
    expect(suite.tests[0]!.steps).toHaveLength(2);
  });

  it('accepts before/after hooks', () => {
    const suite = parseSuite(`
before:
  - navigate: https://example.com
after:
  - clearStorage
tests:
  - name: t
    steps: [openPopup]
`);
    expect(suite.before).toEqual([{ navigate: 'https://example.com' }]);
    expect(suite.after).toEqual([{ clearStorage: null }]);
  });

  it('rejects an unknown step and suggests the closest match', () => {
    expect(() =>
      parseSuite(`
tests:
  - name: t
    steps:
      - assertVisable: "#x"
`),
    ).toThrowError(SuiteParseError);

    try {
      parseSuite(`
tests:
  - name: t
    steps:
      - assertVisable: "#x"
`);
    } catch (err) {
      const e = err as SuiteParseError;
      expect(e.issues.join('\n')).toMatch(/unknown step "assertVisable"/);
      expect(e.issues.join('\n')).toMatch(/assertVisible/);
    }
  });

  it('rejects a step with two action keys', () => {
    try {
      parseSuite(`
tests:
  - name: t
    steps:
      - click: "#a"
        navigate: https://example.com
`);
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as SuiteParseError).issues.join('\n')).toMatch(/exactly one action key/);
    }
  });

  it('rejects a step missing a required option', () => {
    try {
      parseSuite(`
tests:
  - name: t
    steps:
      - fill: { selector: "#a" }
`);
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as SuiteParseError).issues.join('\n')).toMatch(/missing required property "value"/);
    }
  });

  it('reports the line number of a bad key', () => {
    try {
      parseSuite(`tests:\n  - name: t\n    steps:\n      - click: { selector: "#a", nope: 1 }\n`);
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as SuiteParseError).issues.join('\n')).toMatch(/line 4/);
    }
  });

  it('reports malformed YAML rather than crashing', () => {
    expect(() => parseSuite(`tests:\n  - name: [unclosed\n`)).toThrowError(SuiteParseError);
  });

  it('requires at least one test', () => {
    expect(() => parseSuite(`name: empty\ntests: []`)).toThrowError(SuiteParseError);
  });
});

describe('readStep', () => {
  it('reads a bare-string step onto its primary property', () => {
    expect(readStep({ navigate: 'https://example.com' })).toEqual({
      action: 'navigate',
      options: { url: 'https://example.com' },
    });
  });

  it('reads a no-argument step', () => {
    expect(readStep({ openPopup: null })).toEqual({ action: 'openPopup', options: {} });
  });

  it('reads an options bag unchanged', () => {
    expect(readStep({ fill: { selector: '#a', value: 'b' } })).toEqual({
      action: 'fill',
      options: { selector: '#a', value: 'b' },
    });
  });

  it('reads a numeric step onto its primary property', () => {
    expect(readStep({ wait: 250 })).toEqual({ action: 'wait', options: { ms: 250 } });
  });
});
