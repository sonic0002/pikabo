import { describe, expect, it } from 'vitest';
import { auditPermissions, namespacesFor, WATCHED_NAMESPACES } from '../../src/browser/permissions.js';

const run = (declared: string[], observed: string[], stepCount = 20, interactiveSteps = 8) =>
  auditPermissions({ declared, observed, stepCount, interactiveSteps });

describe('auditPermissions', () => {
  it('marks a permission used when its namespace was touched', () => {
    const audit = run(['storage'], ['storage']);
    expect(audit.findings).toEqual([
      { permission: 'storage', verdict: 'used', evidence: ['chrome.storage'] },
    ]);
    expect(audit.unusedCount).toBe(0);
  });

  it('flags a declared permission whose namespace was never touched', () => {
    const audit = run(['storage', 'history'], ['storage']);
    expect(audit.unusedCount).toBe(1);
    expect(audit.findings.find((f) => f.permission === 'history')?.verdict).toBe('not-observed');
  });

  it('flags an API used without its permission declared, which fails in production', () => {
    const audit = run(['storage'], ['storage', 'bookmarks']);
    const finding = audit.findings.find((f) => f.permission === 'bookmarks');
    expect(finding?.verdict).toBe('undeclared');
    expect(audit.undeclaredCount).toBe(1);
  });

  it('never advises removing a permission with no API to observe', () => {
    // activeTab grants transient host access and has no namespace; absence proves nothing.
    const audit = run(['activeTab', 'unlimitedStorage', 'clipboardWrite'], []);
    expect(audit.unusedCount).toBe(0);
    for (const finding of audit.findings) expect(finding.verdict).toBe('not-observable');
  });

  it('treats an unrecognised permission as not observable rather than unused', () => {
    const audit = run(['someFuturePermission'], []);
    expect(audit.findings[0]!.verdict).toBe('not-observable');
    expect(audit.unusedCount).toBe(0);
  });

  it('sorts the most actionable findings first', () => {
    const audit = run(['storage', 'history', 'activeTab'], ['storage', 'cookies']);
    expect(audit.findings.map((f) => f.verdict)).toEqual([
      'undeclared',
      'not-observed',
      'not-observable',
      'used',
    ]);
  });

  it('warns that a near-empty run proves little', () => {
    expect(run(['history'], [], 2).lowCoverage).toBe(true);
    expect(run(['history'], [], 40).lowCoverage).toBe(false);
  });

  it('treats a run that never drove the extension as low coverage', () => {
    // A generated smoke suite opens the popup and reads it: many steps, no interaction. Calling
    // a permission unused on that basis would be advice to delete something still needed.
    expect(run(['downloads'], [], 20, 0).lowCoverage).toBe(true);
    expect(run(['downloads'], [], 20, 2).lowCoverage).toBe(true);
    expect(run(['downloads'], [], 20, 3).lowCoverage).toBe(false);
  });

  it('reports observed namespaces even when they need no permission', () => {
    expect(run([], ['storage']).observed).toEqual(['storage']);
  });

  it('handles an extension declaring nothing', () => {
    const audit = run([], []);
    expect(audit.findings).toEqual([]);
    expect(audit.unusedCount).toBe(0);
    expect(audit.undeclaredCount).toBe(0);
  });
});

describe('the namespace map', () => {
  it('covers the permissions extensions most commonly declare', () => {
    for (const permission of ['storage', 'tabs', 'downloads', 'cookies', 'alarms', 'scripting']) {
      expect(namespacesFor(permission), `${permission} is unmapped`).not.toEqual([]);
    }
  });

  it('watches every namespace it claims to map', () => {
    for (const permission of ['storage', 'history', 'bookmarks']) {
      for (const namespace of namespacesFor(permission)) {
        expect(WATCHED_NAMESPACES).toContain(namespace);
      }
    }
  });

  it('does not watch namespaces that need no permission, which would produce noise', () => {
    // chrome.runtime and chrome.i18n are always available; treating them as evidence would be
    // meaningless, and chrome.permissions is how ext-tester itself checks grants.
    for (const namespace of ['runtime', 'i18n', 'permissions', 'extension']) {
      expect(WATCHED_NAMESPACES).not.toContain(namespace);
    }
  });
});
