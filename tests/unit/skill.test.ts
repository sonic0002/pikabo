import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { detectTargets, installSkill, readSkill } from '../../src/skill.js';
import { STEP_NAMES } from '../../src/dsl/schema.js';

const created: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ext-skill-'));
  created.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('readSkill', () => {
  it('parses frontmatter and body', () => {
    const { frontmatter, body } = readSkill();
    expect(frontmatter).toMatch(/name: testing-extensions/);
    expect(frontmatter).toMatch(/description:/);
    expect(body).not.toMatch(/^---/);
    expect(body.length).toBeGreaterThan(500);
  });

  it('only references steps that actually exist', () => {
    const { body } = readSkill();
    // Suite structure keys, which appear in list position but are not steps.
    const structural = new Set(['name', 'steps', 'tests', 'before', 'after', 'vars', 'skip', 'extension']);
    const referenced = new Set<string>();
    for (const m of body.matchAll(/^\s*- ([a-zA-Z][a-zA-Z0-9]*):?$/gm)) referenced.add(m[1]!);
    for (const m of body.matchAll(/^\s*- ([a-zA-Z][a-zA-Z0-9]*):\s+\S/gm)) referenced.add(m[1]!);

    const unknown = [...referenced].filter((n) => !structural.has(n) && !STEP_NAMES.includes(n));
    expect(unknown, `skill references steps that do not exist: ${unknown.join(', ')}`).toEqual([]);
    // Guard against the check silently passing because nothing matched.
    expect([...referenced].some((n) => STEP_NAMES.includes(n))).toBe(true);
  });

  it('documents the contexts the runner actually supports', () => {
    const { body } = readSkill();
    for (const context of ['page', 'popup', 'options', 'worker']) {
      expect(body).toContain(`\`${context}\``);
    }
  });
});

describe('installSkill', () => {
  it('installs for Claude Code with frontmatter intact', () => {
    const dir = scratch();
    const result = installSkill('claude', dir);
    expect(result.written).toEqual(['.claude/skills/testing-extensions/SKILL.md']);
    const written = readFileSync(join(dir, result.written[0]!), 'utf8');
    expect(written.startsWith('---\nname: testing-extensions')).toBe(true);
  });

  it('installs for Cursor with Cursor frontmatter', () => {
    const dir = scratch();
    const result = installSkill('cursor', dir);
    const written = readFileSync(join(dir, result.written[0]!), 'utf8');
    expect(result.written[0]).toBe('.cursor/rules/testing-extensions.mdc');
    expect(written).toMatch(/^---\ndescription: /);
    expect(written).toMatch(/globs:/);
    expect(written).not.toMatch(/name: testing-extensions/);
  });

  it('creates AGENTS.md and a docs file when neither exists', () => {
    const dir = scratch();
    const result = installSkill('codex', dir);
    expect(result.written).toContain('AGENTS.md');
    expect(result.written).toContain('docs/testing-extensions.md');
    expect(readFileSync(join(dir, 'AGENTS.md'), 'utf8')).toMatch(/ext-tester:begin/);
    expect(result.manual).toBeUndefined();
  });

  it('refuses to touch an existing AGENTS.md without --force', () => {
    const dir = scratch();
    const agents = join(dir, 'AGENTS.md');
    writeFileSync(agents, '# Mine\n\nHand-written guidance.\n');
    const result = installSkill('codex', dir, false);
    expect(result.manual).toMatch(/already exists/);
    expect(readFileSync(agents, 'utf8')).toBe('# Mine\n\nHand-written guidance.\n');
    expect(result.written).not.toContain('AGENTS.md');
  });

  it('appends with --force while preserving what was there', () => {
    const dir = scratch();
    const agents = join(dir, 'AGENTS.md');
    writeFileSync(agents, '# Mine\n\nHand-written guidance.\n');
    installSkill('codex', dir, true);
    const written = readFileSync(agents, 'utf8');
    expect(written).toMatch(/Hand-written guidance/);
    expect(written).toMatch(/ext-tester:begin/);
  });

  it('replaces its own block instead of duplicating it', () => {
    const dir = scratch();
    const agents = join(dir, 'AGENTS.md');
    writeFileSync(agents, '# Mine\n\nHand-written guidance.\n');
    installSkill('codex', dir, true);
    installSkill('codex', dir);
    installSkill('codex', dir);
    const written = readFileSync(agents, 'utf8');
    expect(written.match(/ext-tester:begin/g)).toHaveLength(1);
    expect(written.match(/Hand-written guidance/g)).toHaveLength(1);
  });
});

describe('detectTargets', () => {
  it('finds Claude Code from .claude or CLAUDE.md', () => {
    const dir = scratch();
    mkdirSync(join(dir, '.claude'));
    expect(detectTargets(dir)).toContain('claude');
  });

  it('finds Cursor from either the modern or legacy layout', () => {
    const modern = scratch();
    mkdirSync(join(modern, '.cursor'));
    expect(detectTargets(modern)).toContain('cursor');

    const legacy = scratch();
    writeFileSync(join(legacy, '.cursorrules'), 'rules');
    expect(detectTargets(legacy)).toContain('cursor');
  });

  it('finds AGENTS.md-based agents', () => {
    const dir = scratch();
    writeFileSync(join(dir, 'AGENTS.md'), '# x');
    expect(detectTargets(dir)).toContain('agents');
  });

  it('falls back to claude and agents in a bare repository', () => {
    expect(detectTargets(scratch())).toEqual(['claude', 'agents']);
  });
});

describe('CLI flag wiring', () => {
  it('threads every common flag into RunOptions', () => {
    const cli = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../src/cli.ts'), 'utf8');
    const body = /function toRunOptions\(flags: CommonFlags\): RunOptions \{([^]*?)\n\}/.exec(cli)?.[1] ?? '';
    expect(body).not.toBe('');

    // Declaring an option without reading it here silently does nothing, which is exactly how
    // `--no-clean` shipped broken.
    for (const flag of ['clean', 'grep', 'bail', 'shots', 'video', 'isolation', 'timeout']) {
      expect(body, `toRunOptions ignores flags.${flag}`).toMatch(new RegExp(`flags\\.${flag}\\b`));
    }
  });
});
