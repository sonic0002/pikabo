import type { Step, Suite } from '../types.js';

/**
 * Turn a stream of observed browser events into a runnable suite.
 *
 * The recorder in the page reports raw events; everything about shaping them into readable steps
 * happens here, in Node, where it can be tested without a browser.
 */

export type RecordedContext = 'page' | 'popup' | 'options' | string;

export interface RecordedAction {
  type: 'click' | 'fill' | 'select' | 'check' | 'uncheck' | 'press' | 'navigate';
  context: RecordedContext;
  selector?: string;
  value?: string;
  key?: string;
  url?: string;
  /** Text of the element, used only to make the generated file readable. */
  label?: string;
  timestamp: number;
}

export interface BuildSuiteOptions {
  name: string;
  testName?: string;
  /** Append checks that make the recording useful as a regression test rather than a replay. */
  addAssertions?: boolean;
}

/**
 * Collapse an action stream into steps.
 *
 * Two things make the output readable rather than a transcript: consecutive typing into one field
 * becomes a single `fill` with the final value, and a context switch emits the step that opens
 * that context instead of being implied.
 */
export function actionsToSteps(actions: RecordedAction[], options: BuildSuiteOptions): Step[] {
  const steps: Step[] = [];
  let context: RecordedContext | undefined;

  for (const action of coalesce(actions)) {
    if (action.context !== context) {
      const opener = openerFor(action.context);
      if (opener) steps.push(opener);
      context = action.context;
    }

    switch (action.type) {
      case 'navigate':
        // A navigation inside an extension page is the page opening, already covered by the
        // opener step above.
        if (action.url && !action.url.startsWith('chrome-extension://')) {
          steps.push({ navigate: action.url });
        }
        break;
      case 'click':
        steps.push(describe({ click: action.selector! }, action));
        break;
      case 'fill':
        steps.push({ fill: { selector: action.selector!, value: action.value ?? '' } });
        break;
      case 'select':
        steps.push({ select: { selector: action.selector!, value: action.value ?? '' } });
        break;
      case 'check':
        steps.push({ check: action.selector! });
        break;
      case 'uncheck':
        steps.push({ uncheck: action.selector! });
        break;
      case 'press':
        steps.push(
          action.selector
            ? { press: { key: action.key!, selector: action.selector } }
            : { press: action.key! },
        );
        break;
    }
  }

  if (options.addAssertions && steps.length) {
    steps.push({ screenshot: 'final-state' });
    steps.push({ assertNoConsoleErrors: { contexts: ['popup', 'options', 'worker'] } });
  }
  return steps;
}

export function actionsToSuite(actions: RecordedAction[], options: BuildSuiteOptions): Suite {
  return {
    name: options.name,
    tests: [
      {
        name: options.testName ?? 'recorded interaction',
        steps: actionsToSteps(actions, options),
      },
    ],
  };
}

/**
 * Typing produces one event per keystroke. Keeping only the last value per field turns 12 events
 * into the one step a human would have written.
 */
function coalesce(actions: RecordedAction[]): RecordedAction[] {
  const out: RecordedAction[] = [];
  for (const action of actions) {
    const previous = out[out.length - 1];
    const sameField =
      previous?.type === 'fill' &&
      action.type === 'fill' &&
      previous.selector === action.selector &&
      previous.context === action.context;
    if (sameField) out[out.length - 1] = action;
    else out.push(action);
  }
  return out;
}

function openerFor(context: RecordedContext): Step | undefined {
  if (context === 'popup') return { openPopup: null };
  if (context === 'options') return { openOptions: null };
  return undefined;
}

/** Attach a human-readable description when the element had text worth recording. */
function describe(step: Step, action: RecordedAction): Step {
  if (!action.label) return step;
  const [key] = Object.keys(step);
  const value = step[key!];
  if (typeof value !== 'string') return step;
  return { [key!]: { [key === 'click' ? 'selector' : 'value']: value, description: `${key} ${action.label}` } };
}
