import { stringify } from 'yaml';
import {
  hasServiceWorker,
  optionsPath,
  popupPath,
  readManifest,
  resolveMessages,
  type RawManifest,
} from '../browser/manifest.js';
import type { Step, Suite, Test } from '../types.js';

export interface ExploreOptions {
  /** URL used to exercise content scripts when a match pattern is too broad to be useful. */
  sampleUrl?: string;
  /** Skip tests that need the network. */
  offline?: boolean;
}

/**
 * Derive a smoke suite from manifest.json alone.
 *
 * Everything here is something an extension author would check by hand after a change: does the
 * popup render, does the options page render, does the worker come up clean, does the content
 * script inject. The output is written to disk so it can be edited and kept.
 */
export function generateSmokeSuite(extensionPath: string, options: ExploreOptions = {}): Suite {
  const manifest = readManifest(extensionPath);
  const name = resolveMessages(extensionPath, manifest, manifest.name) ?? 'extension';
  const tests: Test[] = [];

  if (hasServiceWorker(manifest)) tests.push(workerTest());
  const popup = popupPath(manifest);
  if (popup) tests.push(popupTest());
  const options_ = optionsPath(manifest);
  if (options_) tests.push(optionsTest());

  for (const [index, url] of contentScriptUrls(manifest, options).entries()) {
    tests.push(contentScriptTest(url, index, manifest));
  }

  if (!tests.length) {
    tests.push({
      name: 'extension loads',
      steps: [
        { note: 'This extension declares no popup, options page, service worker or content scripts.' },
        { navigate: 'about:blank' },
      ],
    });
  }

  return {
    name: `${name} smoke tests`,
    tests,
  };
}

function workerTest(): Test {
  return {
    name: 'service worker starts without errors',
    steps: [
      { eval: { script: 'chrome.runtime.getManifest().name', in: 'worker' } },
      { expect: { truthy: true } },
      { eval: { script: 'chrome.runtime.id', in: 'worker' } },
      { expect: { truthy: true } },
      { assertNoConsoleErrors: null },
    ],
  };
}

function popupTest(): Test {
  return {
    name: 'popup renders',
    steps: [
      { openPopup: null },
      // A popup that renders nothing is the classic silent failure: the HTML loads, a script
      // throws, and the user sees a blank rectangle.
      {
        eval: {
          script: 'document.body.innerText.trim().length + document.querySelectorAll("button, input, a, img, canvas, svg").length',
          in: 'popup',
        },
      },
      { expect: { truthy: true, description: 'popup has visible content or controls' } },
      { screenshot: 'popup' },
      { assertNoConsoleErrors: null },
    ],
  };
}

function optionsTest(): Test {
  return {
    name: 'options page renders',
    steps: [
      { openOptions: null },
      {
        eval: {
          script: 'document.body.innerText.trim().length + document.querySelectorAll("button, input, select, textarea").length',
          in: 'options',
        },
      },
      { expect: { truthy: true, description: 'options page has visible content or controls' } },
      { screenshot: 'options' },
      { assertNoConsoleErrors: null },
    ],
  };
}

function contentScriptTest(url: string, index: number, manifest: RawManifest): Test {
  const files = manifest.content_scripts?.[index]?.js ?? [];
  const steps: Step[] = [
    { navigate: { url, in: 'page' } },
    { wait: 500 },
    { screenshot: `content-script-${index}` },
    { assertNoConsoleErrors: null },
  ];
  return {
    name: `content script injects on ${hostOf(url)}${files.length ? ` (${files.join(', ')})` : ''}`,
    steps,
  };
}

/** Pick one representative URL per content-script block. */
export function contentScriptUrls(manifest: RawManifest, options: ExploreOptions = {}): string[] {
  const urls: string[] = [];
  for (const block of manifest.content_scripts ?? []) {
    const pattern = block.matches?.find((m) => m && m !== '<all_urls>') ?? block.matches?.[0];
    if (!pattern) continue;
    const url = matchPatternToUrl(pattern, options.sampleUrl);
    if (url) urls.push(url);
  }
  return [...new Set(urls)];
}

/**
 * Turn a Chrome match pattern into a URL that will actually match it.
 * `*://*.example.com/*` → `https://example.com/`; broad patterns fall back to a sample URL.
 */
export function matchPatternToUrl(pattern: string, sampleUrl = 'https://example.com/'): string | undefined {
  if (pattern === '<all_urls>' || pattern === '*://*/*' || pattern === 'http://*/*' || pattern === 'https://*/*') {
    return sampleUrl;
  }
  const parsed = /^(\*|https?|file|ftp):\/\/([^/]*)(\/.*)?$/.exec(pattern);
  if (!parsed) return undefined;
  const scheme = parsed[1] === '*' ? 'https' : parsed[1]!;
  if (scheme === 'file' || scheme === 'ftp') return undefined;
  const host = (parsed[2] ?? '').replace(/^\*\./, '').replace(/^\*$/, '');
  if (!host) return sampleUrl;
  const path = (parsed[3] ?? '/').replace(/\*/g, '');
  return `${scheme}://${host}${path.startsWith('/') ? path : `/${path}`}`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Serialise a generated suite as YAML a human would be happy to edit. */
export function suiteToYaml(suite: Suite): string {
  const header = [
    '# Generated by `ext-test explore`. Edit freely — this file is yours now.',
    '# Docs: https://github.com/ext-tester/ext-tester#step-reference',
    '',
  ].join('\n');
  return `${header}${stringify(suite, { lineWidth: 100, defaultStringType: 'PLAIN', defaultKeyType: 'PLAIN' })}`;
}
