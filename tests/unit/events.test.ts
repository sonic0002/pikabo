import { describe, expect, it } from 'vitest';
import { findExtensionEvent } from '../../src/dsl/steps/events.js';
import type { ExtensionEvent } from '../../src/types.js';

const events: ExtensionEvent[] = [
  {
    sequence: 1,
    type: 'runtime.message',
    source: 'worker',
    timestamp: 1,
    detail: { message: { type: 'ping', payload: { id: 42 } }, sender: { id: 'extension-id' } },
  },
  {
    sequence: 2,
    type: 'storage.changed',
    source: 'worker',
    timestamp: 2,
    detail: { areaName: 'local', changes: { ready: { newValue: true } } },
  },
];

describe('extension event matching', () => {
  it('matches an exact event type and nested partial payload', () => {
    const hit = findExtensionEvent(events, {
      options: { type: 'runtime.message', contains: { message: { type: 'ping' } } },
    });
    expect(hit?.sequence).toBe(1);
  });

  it('supports wildcard types', () => {
    expect(findExtensionEvent(events, { options: { type: 'storage.*' } })?.sequence).toBe(2);
  });

  it('ignores events at or before the test cursor', () => {
    expect(findExtensionEvent(events, { options: { type: 'runtime.message' } }, 1)).toBeUndefined();
  });

  it('can require exact event detail', () => {
    const detail = events[1]!.detail;
    expect(findExtensionEvent(events, { options: { type: 'storage.changed', equals: detail } })).toBe(events[1]);
  });
});
