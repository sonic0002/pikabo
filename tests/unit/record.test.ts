import { describe, expect, it } from 'vitest';
import { actionsToSteps, actionsToSuite, type RecordedAction } from '../../src/record/actions.js';
import { parseSuite } from '../../src/dsl/parse.js';
import { suiteToYaml } from '../../src/explore/generate.js';

let clock = 0;
const action = (partial: Partial<RecordedAction> & Pick<RecordedAction, 'type'>): RecordedAction => ({
  context: 'page',
  timestamp: ++clock,
  ...partial,
});

const build = (actions: RecordedAction[]) => actionsToSteps(actions, { name: 'x' });

describe('actionsToSteps', () => {
  it('collapses a burst of typing into one fill with the final value', () => {
    // The browser reports one input event per keystroke; a transcript of those is unreadable.
    const steps = build([
      action({ type: 'fill', selector: '#label', value: 'W' }),
      action({ type: 'fill', selector: '#label', value: 'We' }),
      action({ type: 'fill', selector: '#label', value: 'Wee' }),
      action({ type: 'fill', selector: '#label', value: 'Weekly' }),
    ]);
    expect(steps).toEqual([{ fill: { selector: '#label', value: 'Weekly' } }]);
  });

  it('keeps separate fields separate', () => {
    const steps = build([
      action({ type: 'fill', selector: '#a', value: 'one' }),
      action({ type: 'fill', selector: '#b', value: 'two' }),
      action({ type: 'fill', selector: '#a', value: 'three' }),
    ]);
    expect(steps).toHaveLength(3);
  });

  it('does not merge typing that happened in different contexts', () => {
    const steps = build([
      action({ type: 'fill', selector: '#label', value: 'a', context: 'popup' }),
      action({ type: 'fill', selector: '#label', value: 'b', context: 'options' }),
    ]);
    expect(steps.filter((s) => 'fill' in s)).toHaveLength(2);
  });

  it('emits the step that opens a context before acting in it', () => {
    // Without this, replay would click in whatever context happened to be active.
    const steps = build([
      action({ type: 'click', selector: '#bump', context: 'popup' }),
      action({ type: 'click', selector: '#save', context: 'options' }),
    ]);
    expect(steps.map((s) => Object.keys(s)[0])).toEqual(['openPopup', 'click', 'openOptions', 'click']);
  });

  it('opens a context once, not before every step in it', () => {
    const steps = build([
      action({ type: 'click', selector: '#a', context: 'popup' }),
      action({ type: 'click', selector: '#b', context: 'popup' }),
    ]);
    expect(steps.filter((s) => 'openPopup' in s)).toHaveLength(1);
  });

  it('records a web navigation but expresses an extension page load as its opener', () => {
    // Loading popup.html is what openPopup means; emitting navigate to a chrome-extension URL as
    // well would be a duplicate step that also hardcodes the extension id.
    const steps = build([
      action({ type: 'navigate', url: 'https://example.com/' }),
      action({ type: 'navigate', url: 'chrome-extension://abc/popup.html', context: 'popup' }),
    ]);
    expect(steps).toEqual([{ navigate: 'https://example.com/' }, { openPopup: null }]);
    expect(JSON.stringify(steps)).not.toMatch(/chrome-extension/);
  });

  it('maps checkbox state to check and uncheck', () => {
    expect(build([action({ type: 'check', selector: '#x' })])).toEqual([{ check: '#x' }]);
    expect(build([action({ type: 'uncheck', selector: '#x' })])).toEqual([{ uncheck: '#x' }]);
  });

  it('records a keypress with and without a target', () => {
    expect(build([action({ type: 'press', key: 'Enter', selector: '#q' })])).toEqual([
      { press: { key: 'Enter', selector: '#q' } },
    ]);
    expect(build([action({ type: 'press', key: 'Escape' })])).toEqual([{ press: 'Escape' }]);
  });

  it('appends checks only when asked, and never to an empty recording', () => {
    const withChecks = actionsToSteps([action({ type: 'click', selector: '#a' })], {
      name: 'x',
      addAssertions: true,
    });
    expect(withChecks.map((s) => Object.keys(s)[0])).toContain('assertNoConsoleErrors');

    expect(actionsToSteps([], { name: 'x', addAssertions: true })).toEqual([]);
  });

  it('labels a click with the element text without breaking the step', () => {
    const steps = build([action({ type: 'click', selector: '#save', label: 'Save' })]);
    expect(steps[0]).toEqual({ click: { selector: '#save', description: 'click Save' } });
  });
});

describe('actionsToSuite', () => {
  it('produces a suite the parser accepts', () => {
    // A recording nobody can run is worthless; round-trip it through the real parser.
    const suite = actionsToSuite(
      [
        action({ type: 'navigate', url: 'https://example.com/' }),
        action({ type: 'click', selector: '#bump', context: 'popup' }),
        action({ type: 'fill', selector: '#label', value: 'hello', context: 'options' }),
      ],
      { name: 'recorded suite', testName: 'does a thing', addAssertions: true },
    );

    const reparsed = parseSuite(suiteToYaml(suite), 'recorded.yaml');
    expect(reparsed.name).toBe('recorded suite');
    expect(reparsed.tests[0]!.name).toBe('does a thing');
    expect(reparsed.tests[0]!.steps.length).toBe(suite.tests[0]!.steps.length);
  });
});
