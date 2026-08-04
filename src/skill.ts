import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Install the bundled skill into whatever convention the local agent uses.
 *
 * The instructions are written once, in `skills/testing-extensions/SKILL.md`, with a body that
 * names no tool and no harness — it says "run this command", which is true everywhere. Each
 * target below is only a question of where the file goes and what, if anything, has to point at
 * it.
 */

export type SkillTarget = 'claude' | 'codex' | 'cursor' | 'agents';

/**
 * `project` installs into the repository being worked on; `global` installs into the agent's own
 * configuration directory, so the skill is available in every project without per-repo setup.
 */
export type SkillScope = 'project' | 'global';

export interface InstallOptions {
  /** Append to an existing AGENTS.md that carries no ext-tester block. */
  force?: boolean;
  scope?: SkillScope;
}

export interface InstallResult {
  target: SkillTarget;
  scope: SkillScope;
  /** Files created or updated, relative to the install directory. */
  written: string[];
  /** Something the user must do by hand, if anything. */
  manual?: string;
}

const MARKER_START = '<!-- ext-tester:begin -->';
const MARKER_END = '<!-- ext-tester:end -->';

export function skillSourcePath(): string {
  // dist/skill.js → repo root, and src/skill.ts → repo root, both resolve the same way.
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, '..', 'skills', 'testing-extensions', 'SKILL.md'),
    join(here, '..', '..', 'skills', 'testing-extensions', 'SKILL.md'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return resolve(candidate);
  }
  throw new Error(
    'Bundled skill not found. Expected skills/testing-extensions/SKILL.md alongside the installed package.',
  );
}

export function readSkill(): { frontmatter: string; body: string; full: string } {
  const full = readFileSync(skillSourcePath(), 'utf8');
  const match = /^---\n([^]*?)\n---\n([^]*)$/.exec(full);
  if (!match) return { frontmatter: '', body: full, full };
  return { frontmatter: match[1] ?? '', body: (match[2] ?? '').trim(), full };
}

export function installSkill(
  target: SkillTarget,
  dir: string,
  options: InstallOptions = {},
): InstallResult {
  const scope = options.scope ?? 'project';
  const root = scope === 'global' ? globalRoot(target) : resolve(dir);
  switch (target) {
    case 'claude':
      return installClaude(root, scope);
    case 'cursor':
      return installCursor(root, scope);
    case 'codex':
    case 'agents':
      return installAgents(root, options.force ?? false, scope);
  }
}

/** Where each agent keeps configuration that applies to every project. */
export function globalRoot(target: SkillTarget): string {
  const home = homedir();
  switch (target) {
    case 'claude':
      return join(home, '.claude');
    case 'cursor':
      return join(home, '.cursor');
    case 'codex':
    case 'agents':
      return join(home, '.codex');
  }
}

/**
 * Claude Code reads `<root>/skills/<name>/SKILL.md`, frontmatter and all — `.claude/skills` in a
 * project, `~/.claude/skills` globally.
 */
function installClaude(root: string, scope: SkillScope): InstallResult {
  const base = scope === 'global' ? root : join(root, '.claude');
  const dest = join(base, 'skills', 'testing-extensions', 'SKILL.md');
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(skillSourcePath(), dest);
  return { target: 'claude', scope, written: [displayPath(dest, root, scope)] };
}

/**
 * Cursor reads `.cursor/rules/*.mdc`, whose frontmatter uses different keys. The body is the
 * same; only the header is rewritten.
 */
function installCursor(root: string, scope: SkillScope): InstallResult {
  const { body } = readSkill();
  const base = scope === 'global' ? root : join(root, '.cursor');
  const dest = join(base, 'rules', 'testing-extensions.mdc');
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(
    dest,
    `---\ndescription: Testing a Chrome extension with ext-tester\nglobs: ["**/manifest.json", "tests/**/*.yaml"]\nalwaysApply: false\n---\n\n${body}\n`,
    'utf8',
  );
  return { target: 'cursor', scope, written: [displayPath(dest, root, scope)] };
}

/**
 * Codex and other AGENTS.md-based agents read one file per repository. The full instructions go
 * in a separate document so AGENTS.md stays short, and AGENTS.md gets a delimited pointer.
 *
 * An existing AGENTS.md is never rewritten wholesale: the block between the markers is replaced
 * if present, appended if not, and everything the user wrote is left alone.
 */
function installAgents(root: string, force: boolean, scope: SkillScope): InstallResult {
  const { body } = readSkill();
  const written: string[] = [];

  // A project install keeps AGENTS.md short by pointing at a doc in the repo. Globally there is
  // no repo to point at, so the instructions are inlined instead of leaving a dangling path.
  let section: string;
  if (scope === 'global') {
    section = body;
  } else {
    const doc = join(root, 'docs', 'testing-extensions.md');
    mkdirSync(dirname(doc), { recursive: true });
    writeFileSync(doc, `${body}\n`, 'utf8');
    written.push(displayPath(doc, root, scope));
    section = [
      '## Testing this extension',
      '',
      'This extension is tested with ext-tester, which loads it into a real Chromium and drives the',
      'popup, options page, content scripts and service worker. Do not ask a human to test by hand.',
      '',
      'Read `docs/testing-extensions.md` before writing or running extension tests. In short:',
      '',
      '```bash',
      'ext-test explore --ext .    # generate a smoke suite from the manifest and run it',
      'ext-test run tests --ext .  # run the suites; non-zero exit means failure',
      '```',
      '',
      'Results land in `ext-test-results/`; read `summary.md` first.',
    ].join('\n');
  }

  const pointer = [MARKER_START, '', section, '', MARKER_END].join('\n');
  const agents = join(root, 'AGENTS.md');

  if (!existsSync(agents)) {
    mkdirSync(dirname(agents), { recursive: true });
    writeFileSync(agents, `# Agent instructions\n\n${pointer}\n`, 'utf8');
    written.push(displayPath(agents, root, scope));
    return { target: 'agents', scope, written };
  }

  const current = readFileSync(agents, 'utf8');
  if (current.includes(MARKER_START) && current.includes(MARKER_END)) {
    writeFileSync(agents, current.replace(new RegExp(`${MARKER_START}[^]*?${MARKER_END}`), pointer), 'utf8');
    written.push(displayPath(agents, root, scope));
    return { target: 'agents', scope, written };
  }

  if (!force) {
    return {
      target: 'agents',
      scope,
      written,
      manual: `${agents} already exists and has no ext-tester block. Add the section yourself, or re-run with --force to append it.`,
    };
  }

  writeFileSync(agents, `${current.trimEnd()}\n\n${pointer}\n`, 'utf8');
  written.push(displayPath(agents, root, scope));
  return { target: 'agents', scope, written };
}

/** Project installs read better relative to the repo; global installs need the absolute path. */
function displayPath(file: string, root: string, scope: SkillScope): string {
  if (scope === 'global') return file.replace(homedir(), '~');
  return relative(root, file);
}


export type SkillStatus = 'current' | 'stale' | 'absent';

export interface SkillCheck {
  target: SkillTarget;
  scope: SkillScope;
  path: string;
  status: SkillStatus;
}

/**
 * Report whether each installed copy still matches the bundled instructions.
 *
 * Installs are copies, not links: a copy cannot break when this package is upgraded or moved,
 * but it also cannot follow along. This is how you find the ones that have fallen behind.
 */
export function checkSkill(target: SkillTarget, dir: string, scope: SkillScope = 'project'): SkillCheck {
  const root = scope === 'global' ? globalRoot(target) : resolve(dir);
  const { full, body } = readSkill();
  const path = installedPath(target, root, scope);
  const display = displayPath(path, root, scope);

  if (!existsSync(path)) return { target, scope, path: display, status: 'absent' };

  const contents = readFileSync(path, 'utf8');
  const expected = target === 'claude' ? full : body;
  const present =
    target === 'agents' || target === 'codex'
      ? extractBlock(contents) ?? contents
      : contents;

  return {
    target,
    scope,
    path: display,
    status: present.includes(expected.trim()) ? 'current' : 'stale',
  };
}

/** The file that carries the instructions for a given target, which is not always AGENTS.md. */
function installedPath(target: SkillTarget, root: string, scope: SkillScope): string {
  switch (target) {
    case 'claude':
      return join(scope === 'global' ? root : join(root, '.claude'), 'skills', 'testing-extensions', 'SKILL.md');
    case 'cursor':
      return join(scope === 'global' ? root : join(root, '.cursor'), 'rules', 'testing-extensions.mdc');
    case 'codex':
    case 'agents':
      // A project install keeps the text in docs/; a global one inlines it into AGENTS.md.
      return scope === 'global' ? join(root, 'AGENTS.md') : join(root, 'docs', 'testing-extensions.md');
  }
}

function extractBlock(contents: string): string | undefined {
  const start = contents.indexOf(MARKER_START);
  const end = contents.indexOf(MARKER_END);
  if (start < 0 || end < 0) return undefined;
  return contents.slice(start + MARKER_START.length, end);
}

/** Which agents appear to be in use here, so the default install does something sensible. */
export function detectTargets(root: string): SkillTarget[] {
  const found: SkillTarget[] = [];
  if (existsSync(join(root, '.claude')) || existsSync(join(root, 'CLAUDE.md'))) found.push('claude');
  if (existsSync(join(root, 'AGENTS.md'))) found.push('agents');
  // `.cursorrules` is the legacy single-file form; either signals Cursor is in use.
  if (existsSync(join(root, '.cursor')) || existsSync(join(root, '.cursorrules'))) found.push('cursor');
  return found.length ? found : ['claude', 'agents'];
}
