import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { checkSkill, detectTargets, globalRoot, installSkill, readSkill } from '../../src/skill.js';
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
    expect(readFileSync(join(dir, 'AGENTS.md'), 'utf8')).toMatch(/pikabo:begin/);
    expect(result.manual).toBeUndefined();
  });

  it('refuses to touch an existing AGENTS.md without --force', () => {
    const dir = scratch();
    const agents = join(dir, 'AGENTS.md');
    writeFileSync(agents, '# Mine\n\nHand-written guidance.\n');
    const result = installSkill('codex', dir, { force: false });
    expect(result.manual).toMatch(/already exists/);
    expect(readFileSync(agents, 'utf8')).toBe('# Mine\n\nHand-written guidance.\n');
    expect(result.written).not.toContain('AGENTS.md');
  });

  it('appends with --force while preserving what was there', () => {
    const dir = scratch();
    const agents = join(dir, 'AGENTS.md');
    writeFileSync(agents, '# Mine\n\nHand-written guidance.\n');
    installSkill('codex', dir, { force: true });
    const written = readFileSync(agents, 'utf8');
    expect(written).toMatch(/Hand-written guidance/);
    expect(written).toMatch(/pikabo:begin/);
  });

  it('replaces its own block instead of duplicating it', () => {
    const dir = scratch();
    const agents = join(dir, 'AGENTS.md');
    writeFileSync(agents, '# Mine\n\nHand-written guidance.\n');
    installSkill('codex', dir, { force: true });
    installSkill('codex', dir);
    installSkill('codex', dir);
    const written = readFileSync(agents, 'utf8');
    expect(written.match(/pikabo:begin/g)).toHaveLength(1);
    expect(written.match(/Hand-written guidance/g)).toHaveLength(1);
  });
});

describe('global scope', () => {
  it('resolves each agent to its own configuration directory', () => {
    expect(globalRoot('claude')).toBe(join(homedir(), '.claude'));
    expect(globalRoot('cursor')).toBe(join(homedir(), '.cursor'));
    expect(globalRoot('codex')).toBe(join(homedir(), '.codex'));
    expect(globalRoot('agents')).toBe(join(homedir(), '.codex'));
  });

  it('never touches the real home directory during tests', () => {
    // Global installs are exercised against an injected home. Without this the suite would
    // overwrite the developer's own ~/.claude/skills every time `npm test` runs.
    const home = scratch();
    installSkill('claude', scratch(), { scope: 'global', home });
    expect(existsSync(join(home, '.claude', 'skills', 'testing-extensions', 'SKILL.md'))).toBe(true);
  });

  it('reports global paths relative to home rather than the working directory', () => {
    // A project-relative path would be nonsense for a global install — the file is nowhere near
    // the repository the command happened to be run from.
    const result = installSkill('claude', scratch(), { scope: 'global', home: scratch() });
    expect(result.scope).toBe('global');
    expect(result.written[0]).toBe('~/.claude/skills/testing-extensions/SKILL.md');
  });

  it('inlines the instructions for a global AGENTS.md instead of pointing at a repo file', () => {
    // `docs/testing-extensions.md` exists in a project install; globally that path would dangle.
    const { body } = readSkill();
    const marker = body.slice(0, 60);
    const project = installSkill('codex', scratch(), { force: true });
    expect(project.written).toContain('docs/testing-extensions.md');

    const home = scratch();
    installSkill('codex', scratch(), { scope: 'global', force: true, home });
    const written = readFileSync(join(home, '.codex', 'AGENTS.md'), 'utf8');
    expect(written).toContain(marker);
    expect(written).not.toContain('Read `docs/testing-extensions.md`');
  });
});

describe('checkSkill', () => {
  it('reports an uninstalled target as absent', () => {
    expect(checkSkill('claude', scratch()).status).toBe('absent');
  });

  it('reports a fresh install as current', () => {
    const dir = scratch();
    installSkill('claude', dir);
    expect(checkSkill('claude', dir).status).toBe('current');
  });

  it('reports an edited copy as stale', () => {
    // Installs are copies, so a copy taken before the instructions changed keeps the old text
    // indefinitely. This is the only way to notice.
    const dir = scratch();
    const result = installSkill('claude', dir);
    writeFileSync(join(dir, result.written[0]!), '---\nname: testing-extensions\n---\n\nold text\n');
    expect(checkSkill('claude', dir).status).toBe('stale');
  });

  it('checks the docs file for a project AGENTS.md install, not AGENTS.md itself', () => {
    const dir = scratch();
    installSkill('codex', dir);
    expect(checkSkill('codex', dir).status).toBe('current');
    writeFileSync(join(dir, 'docs', 'testing-extensions.md'), 'stale content');
    expect(checkSkill('codex', dir).status).toBe('stale');
  });

  it('checks Cursor rules through their rewritten frontmatter', () => {
    const dir = scratch();
    installSkill('cursor', dir);
    expect(checkSkill('cursor', dir).status).toBe('current');
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
