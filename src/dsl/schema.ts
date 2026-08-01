/**
 * The step vocabulary, and a JSON Schema generated from it.
 *
 * Every step is described once here — its arity, its aliases, and what shape its options bag
 * takes. The schema, the runner's dispatch table and the docs all read from this list, so
 * adding a step means adding one entry.
 */

export type StepArity =
  /** `- openPopup` with no argument (may still take an options bag). */
  | 'none'
  /** `- navigate: https://example.com` — a bare string, or an options bag. */
  | 'string'
  /** `- wait: 500` — a number, or an options bag. */
  | 'number'
  /** `- assertStorage: {...}` — always an options bag. */
  | 'object';

export interface StepSpec {
  name: string;
  arity: StepArity;
  /** Name of the property a bare scalar is assigned to. */
  primary?: string;
  /** Additional accepted property names beyond `primary`, `in`, `timeout`, `description`. */
  props?: string[];
  /** Required properties when written as an options bag. */
  required?: string[];
  summary: string;
}

export const STEP_SPECS: StepSpec[] = [
  // ---- navigation & lifecycle ----
  { name: 'navigate', arity: 'string', primary: 'url', props: ['waitUntil'], summary: 'Navigate the target context to a URL.' },
  { name: 'openPopup', arity: 'none', props: ['width', 'height'], summary: "Open the extension's popup as a page and make it the active context." },
  { name: 'openOptions', arity: 'none', summary: "Open the extension's options page and make it the active context." },
  { name: 'closePopup', arity: 'none', summary: 'Close the popup page.' },
  { name: 'reloadExtension', arity: 'none', summary: 'Call chrome.runtime.reload() and wait for the worker to come back.' },
  { name: 'newTab', arity: 'string', primary: 'url', props: ['name'], summary: 'Open a new tab, optionally naming it for later `switchTo`.' },
  { name: 'switchTo', arity: 'string', primary: 'context', summary: 'Make a named context active for subsequent steps.' },
  { name: 'wait', arity: 'number', primary: 'ms', summary: 'Wait a fixed number of milliseconds.' },

  // ---- interaction ----
  { name: 'click', arity: 'string', primary: 'selector', props: ['button', 'clickCount', 'force'], summary: 'Click an element.' },
  { name: 'fill', arity: 'object', props: ['selector', 'value'], required: ['selector', 'value'], summary: 'Set the value of an input.' },
  { name: 'type', arity: 'object', props: ['selector', 'text', 'delay'], required: ['selector', 'text'], summary: 'Type text with per-key events.' },
  { name: 'press', arity: 'string', primary: 'key', props: ['selector'], summary: 'Press a key.' },
  { name: 'select', arity: 'object', props: ['selector', 'value'], required: ['selector', 'value'], summary: 'Choose an option in a <select>.' },
  { name: 'check', arity: 'string', primary: 'selector', summary: 'Check a checkbox or radio.' },
  { name: 'uncheck', arity: 'string', primary: 'selector', summary: 'Uncheck a checkbox.' },
  { name: 'hover', arity: 'string', primary: 'selector', summary: 'Hover over an element.' },
  { name: 'scroll', arity: 'object', props: ['selector', 'x', 'y'], summary: 'Scroll the page or an element.' },
  { name: 'upload', arity: 'object', props: ['selector', 'files'], required: ['selector', 'files'], summary: 'Attach files to a file input.' },

  // ---- waiting ----
  { name: 'waitFor', arity: 'string', primary: 'selector', props: ['state'], summary: 'Wait for a selector to reach a state.' },
  { name: 'waitForText', arity: 'string', primary: 'text', props: ['selector'], summary: 'Wait for text to appear.' },
  { name: 'waitForDownload', arity: 'string', primary: 'pattern', props: ['saveAs'], summary: 'Wait for a download whose filename matches a glob.' },
  { name: 'waitForUrl', arity: 'string', primary: 'pattern', summary: 'Wait for the context URL to match a glob or regex.' },

  // ---- assertions ----
  { name: 'assertVisible', arity: 'string', primary: 'selector', props: ['not'], summary: 'Assert an element is visible.' },
  { name: 'assertText', arity: 'object', props: ['selector', 'equals', 'contains', 'matches', 'not'], summary: 'Assert on an element’s text.' },
  { name: 'assertCount', arity: 'object', props: ['selector', 'equals', 'atLeast', 'atMost'], required: ['selector'], summary: 'Assert how many elements match a selector.' },
  { name: 'assertUrl', arity: 'object', props: ['equals', 'contains', 'matches'], summary: 'Assert on the context URL.' },
  { name: 'assertStorage', arity: 'object', props: ['key', 'area', 'equals', 'contains', 'exists'], required: ['key'], summary: 'Assert on a chrome.storage value.' },
  { name: 'assertNoConsoleErrors', arity: 'none', props: ['ignore'], summary: 'Assert no console errors were logged in any context so far.' },
  { name: 'assertDownload', arity: 'object', props: ['pattern', 'minBytes'], summary: 'Assert a matching download has occurred.' },
  { name: 'assertPermission', arity: 'string', primary: 'permission', props: ['not'], summary: 'Assert the extension holds a permission at runtime.' },
  { name: 'expect', arity: 'object', props: ['value', 'equals', 'contains', 'matches', 'truthy'], summary: 'Assert on the value produced by the previous `eval`.' },

  // ---- capture & escape hatch ----
  { name: 'screenshot', arity: 'string', primary: 'name', props: ['fullPage', 'selector'], summary: 'Capture a named screenshot.' },
  { name: 'note', arity: 'string', primary: 'text', summary: 'Record a note in the report without acting.' },
  { name: 'eval', arity: 'string', primary: 'script', props: ['args'], summary: 'Run JavaScript in the target context and capture its return value.' },
  { name: 'setStorage', arity: 'object', props: ['key', 'value', 'area'], required: ['key'], summary: 'Write a chrome.storage value.' },
  { name: 'clearStorage', arity: 'none', props: ['area'], summary: 'Clear a chrome.storage area.' },
];

export const STEP_NAMES = STEP_SPECS.map((s) => s.name);

export const STEP_BY_NAME = new Map(STEP_SPECS.map((s) => [s.name, s]));

const COMMON_PROPS = {
  in: { type: 'string', description: 'Context to act on: page, popup, options, worker, or a named tab.' },
  timeout: { type: 'number', description: 'Step timeout in milliseconds.' },
  description: { type: 'string', description: 'Overrides the label shown in the report.' },
};

function stepObjectSchema(spec: StepSpec): Record<string, unknown> {
  const properties: Record<string, unknown> = { ...COMMON_PROPS };
  const names = new Set<string>([...(spec.props ?? [])]);
  if (spec.primary) names.add(spec.primary);
  for (const p of names) properties[p] = {};
  const schema: Record<string, unknown> = {
    type: 'object',
    properties,
    additionalProperties: false,
  };
  if (spec.required?.length) schema['required'] = spec.required;
  return schema;
}

/** The value accepted for a given step key. */
function stepValueSchema(spec: StepSpec): Record<string, unknown> {
  const objectForm = stepObjectSchema(spec);
  switch (spec.arity) {
    case 'none':
      return { anyOf: [{ type: 'null' }, { type: 'boolean' }, objectForm] };
    case 'string':
      return { anyOf: [{ type: 'string' }, objectForm] };
    case 'number':
      return { anyOf: [{ type: 'number' }, objectForm] };
    case 'object':
      return objectForm;
  }
}

const stepSchema = {
  type: 'object',
  minProperties: 1,
  maxProperties: 1,
  properties: Object.fromEntries(STEP_SPECS.map((s) => [s.name, stepValueSchema(s)])),
  additionalProperties: false,
} as const;

/**
 * A step written as a bare string — `- openPopup` — parses to the string `"openPopup"` in YAML.
 * The parser normalises those before validation, so the schema only sees objects.
 */
export const SUITE_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://github.com/ext-tester/schema/suite.schema.json',
  title: 'ext-tester suite',
  type: 'object',
  required: ['tests'],
  properties: {
    name: { type: 'string' },
    extension: { type: 'string' },
    defaultContext: { type: 'string' },
    timeout: { type: 'number' },
    vars: { type: 'object' },
    before: { type: 'array', items: stepSchema },
    after: { type: 'array', items: stepSchema },
    tests: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['name', 'steps'],
        properties: {
          name: { type: 'string' },
          skip: { type: 'boolean' },
          timeout: { type: 'number' },
          steps: { type: 'array', minItems: 1, items: stepSchema },
        },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
} as const;
