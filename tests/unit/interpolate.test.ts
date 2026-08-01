import { describe, expect, it } from 'vitest';
import { interpolate } from '../../src/dsl/interpolate.js';

const scope = {
  vars: { user: 'ada', config: { theme: 'dark', tags: ['a', 'b'] } },
  last: { id: 7, name: 'result' },
  env: { API_KEY: 'secret' },
};

describe('interpolate', () => {
  it('substitutes a var into a larger string', () => {
    expect(interpolate('hello ${vars.user}', scope)).toBe('hello ada');
  });

  it('preserves type when the reference is the whole string', () => {
    expect(interpolate('${last}', scope)).toEqual({ id: 7, name: 'result' });
    expect(interpolate('${vars.config.tags}', scope)).toEqual(['a', 'b']);
  });

  it('reads nested paths', () => {
    expect(interpolate('${vars.config.theme}', scope)).toBe('dark');
    expect(interpolate('${last.name}', scope)).toBe('result');
  });

  it('reads from env', () => {
    expect(interpolate('${env.API_KEY}', scope)).toBe('secret');
  });

  it('stringifies objects embedded in a larger string', () => {
    expect(interpolate('id=${last.id} all=${last}', scope)).toBe('id=7 all={"id":7,"name":"result"}');
  });

  it('leaves unknown references untouched so the failure is visible', () => {
    expect(interpolate('${vars.missing}', scope)).toBe('${vars.missing}');
    expect(interpolate('${nonsense}', scope)).toBe('${nonsense}');
  });

  it('walks arrays and nested objects', () => {
    expect(
      interpolate({ selector: '#${vars.user}', items: ['${last.id}', 'literal'] }, scope),
    ).toEqual({ selector: '#ada', items: [7, 'literal'] });
  });

  it('leaves non-strings alone', () => {
    expect(interpolate(42, scope)).toBe(42);
    expect(interpolate(true, scope)).toBe(true);
    expect(interpolate(null, scope)).toBe(null);
  });
});
