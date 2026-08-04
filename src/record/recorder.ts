import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { stringify } from 'yaml';
import { Session } from '../browser/session.js';
import { STEP_REFERENCE_URL } from '../constants.js';
import type { Suite } from '../types.js';
import { actionsToSuite, type RecordedAction, type BuildSuiteOptions } from './actions.js';

export interface RecordOptions {
  extensionPath: string;
  /** Page to open before recording starts. */
  url?: string;
  outFile: string;
  suiteName?: string;
  testName?: string;
  addAssertions?: boolean;
  /** Open the popup as a tab at startup, since a toolbar popup cannot be driven. */
  openPopup?: boolean;
  onAction?: (action: RecordedAction, total: number) => void;
  /**
   * Run without a visible window. Pointless for a human, but it lets a scripted recording be
   * verified end to end — record, then replay what was written.
   */
  headless?: boolean;
  /**
   * Drive the session programmatically instead of waiting for a person. Recording stops when
   * this resolves.
   */
  onReady?: (session: Session) => Promise<void>;
}

export interface RecordResult {
  suite: Suite;
  file: string;
  actions: RecordedAction[];
}

/**
 * Record a session in a real browser and write it out as a suite.
 *
 * The popup is opened as a tab rather than through the toolbar icon. A toolbar popup is browser
 * chrome that automation cannot click, and — more importantly — a suite replays it as a tab, so
 * recording it any other way would capture selectors against a surface the run never reproduces.
 */
export async function record(options: RecordOptions): Promise<RecordResult> {
  const actions: RecordedAction[] = [];
  const session = await Session.start({
    extensionPath: options.extensionPath,
    headless: options.headless ?? false,
    debugPort: true,
  });

  try {
    await session.context.exposeBinding('__extTestRecord', (source, action: RecordedAction) => {
      const url = source.page.url();
      const context = contextFor(url, session);
      const entry = { ...action, context, timestamp: Date.now() };
      actions.push(entry);
      options.onAction?.(entry, actions.length);
    });
    await session.context.addInitScript(RECORDER_SCRIPT);

    if (options.url) {
      const page = session.page('page');
      await page.goto(options.url, { waitUntil: 'domcontentloaded' });
      actions.push({ type: 'navigate', context: 'page', url: options.url, timestamp: Date.now() });
    }
    if (options.openPopup !== false && session.extension.popup) await session.openPopup();

    if (options.onReady) await options.onReady(session);
    else await waitForClose(session);
  } finally {
    await session.close().catch(() => undefined);
  }

  const buildOptions: BuildSuiteOptions = {
    name: options.suiteName ?? `${session.extension.name} recorded`,
    testName: options.testName,
    addAssertions: options.addAssertions ?? true,
  };
  const suite = actionsToSuite(actions, buildOptions);
  const file = resolve(options.outFile);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, serialise(suite), 'utf8');
  return { suite, file, actions };
}

function contextFor(url: string, session: Session): string {
  const extension = session.extension;
  if (extension.popup && url.includes(extension.popup)) return 'popup';
  if (extension.optionsPage && url.includes(extension.optionsPage)) return 'options';
  return 'page';
}

/** Recording ends when the user closes the browser, or on Ctrl-C. */
async function waitForClose(session: Session): Promise<void> {
  await new Promise<void>((resolveWait) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      process.off('SIGINT', finish);
      resolveWait();
    };
    session.context.on('close', finish);
    process.on('SIGINT', finish);
  });
}

function serialise(suite: Suite): string {
  return (
    [
      '# Recorded by `ext-test record`. Edit freely — this file is yours now.',
      `# Step reference: ${STEP_REFERENCE_URL}`,
      '#',
      '# A recording captures what you did, not what should be true. Add assertions where the',
      '# outcome matters: assertText, assertStorage, assertPdf.',
      '',
    ].join('\n') + tidy(stringify(suite, { lineWidth: 100, defaultStringType: 'PLAIN', defaultKeyType: 'PLAIN' }))
  );
}

/**
 * A no-argument step serialises as `- openPopup: null`, which is valid but not what anyone
 * writes. The DSL accepts the bare form, so emit that.
 */
function tidy(yaml: string): string {
  return yaml.replace(/^(\s*)- ([A-Za-z][A-Za-z0-9]*): null$/gm, '$1- $2');
}

/**
 * Injected into every page. Reports interactions through the exposed binding.
 *
 * Selector choice decides whether a recording still runs next month, so it prefers whatever the
 * author gave the element deliberately — id, test id, name, aria-label — before falling back to
 * text, and only then to a structural path.
 */
const RECORDER_SCRIPT = `(() => {
  const scope = window;
  if (scope.__extTestRecorderInstalled) return;
  scope.__extTestRecorderInstalled = true;

  const send = (action) => {
    try {
      if (scope.__extTestRecord) scope.__extTestRecord(action);
    } catch {
      /* the page is going away */
    }
  };

  const isUnique = (selector) => {
    try {
      return document.querySelectorAll(selector).length === 1;
    } catch {
      return false;
    }
  };

  // Ids generated by frameworks change between runs and make a recording worthless.
  const looksGenerated = (value) =>
    value.length > 24 || /^[0-9]/.test(value) || /[0-9a-f]{8}/i.test(value) || /:r[0-9a-z]+:/i.test(value);

  const escape = (value) => (scope.CSS && CSS.escape ? CSS.escape(value) : value.replace(/["\\\\]/g, '\\\\$&'));

  const selectorFor = (element) => {
    if (!element || element.nodeType !== 1) return undefined;

    if (element.id && !looksGenerated(element.id) && isUnique('#' + escape(element.id))) {
      return '#' + escape(element.id);
    }
    for (const attribute of ['data-testid', 'data-test-id', 'data-test', 'name', 'aria-label']) {
      const value = element.getAttribute && element.getAttribute(attribute);
      if (!value) continue;
      const candidate = '[' + attribute + '="' + value.replace(/"/g, '\\\\"') + '"]';
      if (isUnique(candidate)) return candidate;
    }
    const classes = (element.className && typeof element.className === 'string' ? element.className : '')
      .split(/\\s+/)
      .filter((c) => c && !looksGenerated(c));
    for (const className of classes) {
      const candidate = element.tagName.toLowerCase() + '.' + escape(className);
      if (isUnique(candidate)) return candidate;
    }
    // Playwright resolves text= engines, and a label is the most durable thing about a button.
    const text = (element.textContent || '').trim();
    if (text && text.length <= 40 && /^(BUTTON|A|SUMMARY|LABEL)$/.test(element.tagName)) {
      return 'text=' + text;
    }
    return pathTo(element);
  };

  const pathTo = (element) => {
    const parts = [];
    let node = element;
    while (node && node.nodeType === 1 && parts.length < 5) {
      let part = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const siblings = [...parent.children].filter((c) => c.tagName === node.tagName);
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      if (node.id && !looksGenerated(node.id)) {
        parts.unshift('#' + escape(node.id));
        break;
      }
      node = parent;
    }
    return parts.join(' > ');
  };

  const labelFor = (element) => {
    const text = (element.textContent || element.value || element.getAttribute('aria-label') || '').trim();
    return text && text.length <= 40 ? text : undefined;
  };

  const CLICKABLE = 'button, a, input[type=button], input[type=submit], [role=button], summary, label';

  document.addEventListener(
    'click',
    (event) => {
      const target = event.target;
      if (!target || target.nodeType !== 1) return;
      const element = target.closest(CLICKABLE) || target;
      // A click that only focuses a field is noise; the fill step records the outcome.
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName) && !/button|submit/i.test(element.type || '')) return;
      const selector = selectorFor(element);
      if (selector) send({ type: 'click', selector, label: labelFor(element) });
    },
    true,
  );

  document.addEventListener(
    'input',
    (event) => {
      const element = event.target;
      if (!element || !/^(INPUT|TEXTAREA)$/.test(element.tagName)) return;
      if (/^(checkbox|radio|button|submit|file)$/i.test(element.type || '')) return;
      const selector = selectorFor(element);
      if (selector) send({ type: 'fill', selector, value: element.value });
    },
    true,
  );

  document.addEventListener(
    'change',
    (event) => {
      const element = event.target;
      if (!element || element.nodeType !== 1) return;
      const selector = selectorFor(element);
      if (!selector) return;
      if (element.tagName === 'SELECT') send({ type: 'select', selector, value: element.value });
      else if (/^(checkbox|radio)$/i.test(element.type || '')) {
        send({ type: element.checked ? 'check' : 'uncheck', selector });
      }
    },
    true,
  );

  document.addEventListener(
    'keydown',
    (event) => {
      if (!['Enter', 'Escape', 'Tab'].includes(event.key)) return;
      const element = event.target;
      const selector = element && element.nodeType === 1 ? selectorFor(element) : undefined;
      send({ type: 'press', key: event.key, selector });
    },
    true,
  );
})();`;
