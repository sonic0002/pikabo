import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

export interface InstallResult {
  target: SkillTarget;
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

export function installSkill(target: SkillTarget, dir: string, force = false): InstallResult {
  const root = resolve(dir);
  switch (target) {
    case 'claude':
      return installClaude(root);
    case 'cursor':
      return installCursor(root);
    case 'codex':
    case 'agents':
      return installAgents(root, force);
  }
}

/** Claude Code reads `.claude/skills/<name>/SKILL.md`, frontmatter and all. */
function installClaude(root: string): InstallResult {
  const dest = join(root, '.claude', 'skills', 'testing-extensions', 'SKILL.md');
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(skillSourcePath(), dest);
  return { target: 'claude', written: [relative(root, dest)] };
}

/**
 * Cursor reads `.cursor/rules/*.mdc`, whose frontmatter uses different keys. The body is the
 * same; only the header is rewritten.
 */
function installCursor(root: string): InstallResult {
  const { body } = readSkill();
  const dest = join(root, '.cursor', 'rules', 'testing-extensions.mdc');
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(
    dest,
    `---\ndescription: Testing a Chrome extension with ext-tester\nglobs: ["**/manifest.json", "tests/**/*.yaml"]\nalwaysApply: false\n---\n\n${body}\n`,
    'utf8',
  );
  return { target: 'cursor', written: [relative(root, dest)] };
}

/**
 * Codex and other AGENTS.md-based agents read one file per repository. The full instructions go
 * in a separate document so AGENTS.md stays short, and AGENTS.md gets a delimited pointer.
 *
 * An existing AGENTS.md is never rewritten wholesale: the block between the markers is replaced
 * if present, appended if not, and everything the user wrote is left alone.
 */
function installAgents(root: string, force: boolean): InstallResult {
  const doc = join(root, 'docs', 'testing-extensions.md');
  mkdirSync(dirname(doc), { recursive: true });
  const { body } = readSkill();
  writeFileSync(doc, `${body}\n`, 'utf8');

  const agents = join(root, 'AGENTS.md');
  const pointer = [
    MARKER_START,
    '',
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
    '',
    MARKER_END,
  ].join('\n');

  const written = [relative(root, doc)];

  if (!existsSync(agents)) {
    writeFileSync(agents, `# Agent instructions\n\n${pointer}\n`, 'utf8');
    written.push(relative(root, agents));
    return { target: 'agents', written };
  }

  const current = readFileSync(agents, 'utf8');
  if (current.includes(MARKER_START) && current.includes(MARKER_END)) {
    const replaced = current.replace(
      new RegExp(`${MARKER_START}[^]*?${MARKER_END}`),
      pointer,
    );
    writeFileSync(agents, replaced, 'utf8');
    written.push(relative(root, agents));
    return { target: 'agents', written };
  }

  if (!force) {
    return {
      target: 'agents',
      written,
      manual: `AGENTS.md already exists and has no ext-tester block. Add the section yourself, or re-run with --force to append it:\n\n${pointer}`,
    };
  }

  writeFileSync(agents, `${current.trimEnd()}\n\n${pointer}\n`, 'utf8');
  written.push(relative(root, agents));
  return { target: 'agents', written };
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
