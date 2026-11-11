import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Install the bundled skill into whatever convention the local agent uses.
 *
 * The instructions are written once, in `skills/pikabo-testing-extensions/SKILL.md`, with a body that
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
  /** Append to an existing AGENTS.md that carries no pikabo block. */
  force?: boolean;
  scope?: SkillScope;
  /**
   * Home directory used to resolve global paths. Injectable so tests can exercise global installs
   * without writing into the developer's own agent configuration.
   */
  home?: string;
}

export interface InstallResult {
  target: SkillTarget;
  scope: SkillScope;
  /** Files created or updated, relative to the install directory. */
  written: string[];
  /** Copies under an earlier skill name that were removed, in the same form as `written`. */
  removed?: string[];
  /** Something the user must do by hand, if anything. */
  manual?: string;
}

/**
 * The skill's name, which is also the folder and file name every install target uses. Prefixed
 * with the package name so a directory search for "pikabo" finds it and it cannot collide with
 * another package's generic `testing-extensions`.
 */
export const SKILL_NAME = 'pikabo-testing-extensions';

/** Names earlier releases installed under. Copies left there are removed on the next install. */
const LEGACY_NAMES = ['testing-extensions'];

const MARKER_START = '<!-- pikabo:begin -->';
const MARKER_END = '<!-- pikabo:end -->';

export function skillSourcePath(): string {
  // dist/skill.js → repo root, and src/skill.ts → repo root, both resolve the same way.
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, '..', 'skills', SKILL_NAME, 'SKILL.md'),
    join(here, '..', '..', 'skills', SKILL_NAME, 'SKILL.md'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return resolve(candidate);
  }
  throw new Error(
    `Bundled skill not found. Expected skills/${SKILL_NAME}/SKILL.md alongside the installed package.`,
  );
}

export function readSkill(): { frontmatter: string; body: string; full: string } {
  // Normalised to LF so a Windows checkout (git converts to CRLF) still parses, and so the file
  // this writes into a repo is byte-identical on every platform — `skill check` compares content.
  const full = readFileSync(skillSourcePath(), 'utf8').replace(/\r\n/g, '\n');
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
  const home = options.home ?? homedir();
  const root = scope === 'global' ? globalRoot(target, home) : resolve(dir);
  let result: InstallResult;
  switch (target) {
    case 'claude':
      result = installClaude(root, scope, home);
      break;
    case 'cursor':
      result = installCursor(root, scope, home);
      break;
    case 'codex':
    case 'agents':
      result = installAgents(root, options.force ?? false, scope, home);
      break;
  }
  // Only once the current copy is in place, and never when the install stopped for a manual step,
  // so a run that writes nothing does not also take the old instructions away.
  if (result.written.length) {
    const removed = removeLegacy(target, root, scope, home);
    if (removed.length) result.removed = removed;
  }
  return result;
}

/**
 * Delete copies installed under an earlier skill name, so an agent does not load the same
 * instructions twice. Only files this module wrote are touched: each must mention pikabo, and
 * the Claude skill folder is removed only if nothing else was put in it.
 */
function removeLegacy(target: SkillTarget, root: string, scope: SkillScope, home: string): string[] {
  const removed: string[] = [];
  for (const name of LEGACY_NAMES) {
    // A global agents install inlines the text into AGENTS.md, which the marker block already
    // replaced; there is no separate file to clean up.
    if (scope === 'global' && (target === 'agents' || target === 'codex')) continue;
    const file = installedPath(target, root, scope, name);
    if (!existsSync(file) || !readFileSync(file, 'utf8').includes('pikabo')) continue;
    unlinkSync(file);
    removed.push(displayPath(file, root, scope, home));
    if (target === 'claude' && readdirSync(dirname(file)).length === 0) rmdirSync(dirname(file));
  }
  return removed;
}

/** Where each agent keeps configuration that applies to every project. */
export function globalRoot(target: SkillTarget, home: string = homedir()): string {
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
function installClaude(root: string, scope: SkillScope, home: string): InstallResult {
  const base = scope === 'global' ? root : join(root, '.claude');
  const dest = join(base, 'skills', SKILL_NAME, 'SKILL.md');
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(skillSourcePath(), dest);
  return { target: 'claude', scope, written: [displayPath(dest, root, scope, home)] };
}

/**
 * Cursor reads `.cursor/rules/*.mdc`, whose frontmatter uses different keys. The body is the
 * same; only the header is rewritten.
 */
function installCursor(root: string, scope: SkillScope, home: string): InstallResult {
  const { body } = readSkill();
  const base = scope === 'global' ? root : join(root, '.cursor');
  const dest = join(base, 'rules', `${SKILL_NAME}.mdc`);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(
    dest,
    `---\ndescription: Testing a Chrome extension with pikabo\nglobs: ["**/manifest.json", "tests/**/*.yaml"]\nalwaysApply: false\n---\n\n${body}\n`,
    'utf8',
  );
  return { target: 'cursor', scope, written: [displayPath(dest, root, scope, home)] };
}

/**
 * Codex and other AGENTS.md-based agents read one file per repository. The full instructions go
 * in a separate document so AGENTS.md stays short, and AGENTS.md gets a delimited pointer.
 *
 * An existing AGENTS.md is never rewritten wholesale: the block between the markers is replaced
 * if present, appended if not, and everything the user wrote is left alone.
 */
function installAgents(root: string, force: boolean, scope: SkillScope, home: string): InstallResult {
  const { body } = readSkill();
  const written: string[] = [];

  // A project install keeps AGENTS.md short by pointing at a doc in the repo. Globally there is
  // no repo to point at, so the instructions are inlined instead of leaving a dangling path.
  let section: string;
  if (scope === 'global') {
    section = body;
  } else {
    const doc = join(root, 'docs', `${SKILL_NAME}.md`);
    mkdirSync(dirname(doc), { recursive: true });
    writeFileSync(doc, `${body}\n`, 'utf8');
    written.push(displayPath(doc, root, scope, home));
    section = [
      '## Testing this extension',
      '',
      'This extension is tested with pikabo, which loads it into a real Chromium and drives the',
      'popup, options page, content scripts and service worker. Do not ask a human to test by hand.',
      '',
      `Read \`docs/${SKILL_NAME}.md\` before writing or running extension tests. In short:`,
      '',
      '```bash',
      'pikabo explore --ext .    # generate a smoke suite from the manifest and run it',
      'pikabo run tests --ext .  # run the suites; non-zero exit means failure',
      '```',
      '',
      'Results land in `pikabo-results/`; read `summary.md` first.',
    ].join('\n');
  }

  const pointer = [MARKER_START, '', section, '', MARKER_END].join('\n');
  const agents = join(root, 'AGENTS.md');

  if (!existsSync(agents)) {
    mkdirSync(dirname(agents), { recursive: true });
    writeFileSync(agents, `# Agent instructions\n\n${pointer}\n`, 'utf8');
    written.push(displayPath(agents, root, scope, home));
    return { target: 'agents', scope, written };
  }

  const current = readFileSync(agents, 'utf8');
  if (current.includes(MARKER_START) && current.includes(MARKER_END)) {
    writeFileSync(agents, current.replace(new RegExp(`${MARKER_START}[^]*?${MARKER_END}`), pointer), 'utf8');
    written.push(displayPath(agents, root, scope, home));
    return { target: 'agents', scope, written };
  }

  if (!force) {
    return {
      target: 'agents',
      scope,
      written,
      manual: `${agents} already exists and has no pikabo block. Add the section yourself, or re-run with --force to append it.`,
    };
  }

  writeFileSync(agents, `${current.trimEnd()}\n\n${pointer}\n`, 'utf8');
  written.push(displayPath(agents, root, scope, home));
  return { target: 'agents', scope, written };
}

/**
 * Project installs read better relative to the repo; global installs need the absolute path.
 *
 * Always reported with forward slashes. These paths are printed next to the `docs/<skill>.md`
 * reference written into AGENTS.md, which is committed and read on every platform, so a Windows
 * run that reported `docs\<skill>.md` named the same file two different ways.
 */
function displayPath(file: string, root: string, scope: SkillScope, home: string): string {
  const shown = scope === 'global' ? file.replace(home, '~') : relative(root, file);
  return shown.split(sep).join('/');
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
export function checkSkill(
  target: SkillTarget,
  dir: string,
  scope: SkillScope = 'project',
  home: string = homedir(),
): SkillCheck {
  const root = scope === 'global' ? globalRoot(target, home) : resolve(dir);
  const { full, body } = readSkill();
  const path = installedPath(target, root, scope);
  const display = displayPath(path, root, scope, home);

  if (!existsSync(path)) {
    // A copy under an earlier name is installed but behind: report it so `install` refreshes it.
    for (const name of LEGACY_NAMES) {
      const legacy = installedPath(target, root, scope, name);
      if (existsSync(legacy)) {
        return { target, scope, path: displayPath(legacy, root, scope, home), status: 'stale' };
      }
    }
    return { target, scope, path: display, status: 'absent' };
  }

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
function installedPath(target: SkillTarget, root: string, scope: SkillScope, name: string = SKILL_NAME): string {
  switch (target) {
    case 'claude':
      return join(scope === 'global' ? root : join(root, '.claude'), 'skills', name, 'SKILL.md');
    case 'cursor':
      return join(scope === 'global' ? root : join(root, '.cursor'), 'rules', `${name}.mdc`);
    case 'codex':
    case 'agents':
      // A project install keeps the text in docs/; a global one inlines it into AGENTS.md.
      return scope === 'global' ? join(root, 'AGENTS.md') : join(root, 'docs', `${name}.md`);
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
