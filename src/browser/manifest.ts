import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface RawManifest {
  manifest_version?: number;
  name?: string;
  version?: string;
  default_locale?: string;
  action?: { default_popup?: string };
  browser_action?: { default_popup?: string };
  page_action?: { default_popup?: string };
  options_page?: string;
  options_ui?: { page?: string };
  background?: { service_worker?: string; scripts?: string[]; page?: string };
  content_scripts?: { matches?: string[]; js?: string[]; css?: string[] }[];
  permissions?: string[];
  host_permissions?: string[];
  commands?: Record<string, { suggested_key?: unknown; description?: string }>;
  devtools_page?: string;
  side_panel?: { default_path?: string };
}

export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManifestError';
  }
}

export function readManifest(extensionPath: string): RawManifest {
  const dir = resolve(extensionPath);
  if (!existsSync(dir)) throw new ManifestError(`Extension directory not found: ${dir}`);
  const file = join(dir, 'manifest.json');
  if (!existsSync(file)) {
    throw new ManifestError(
      `No manifest.json in ${dir}. Point --ext at the directory containing manifest.json, not a .zip or a parent folder.`,
    );
  }
  let raw: unknown;
  try {
    // Chrome tolerates comments in manifest.json; strip them so we do too.
    raw = JSON.parse(stripJsonComments(readFileSync(file, 'utf8')));
  } catch (err) {
    throw new ManifestError(`manifest.json is not valid JSON: ${(err as Error).message}`);
  }
  if (raw == null || typeof raw !== 'object') throw new ManifestError('manifest.json must be an object');
  return raw as RawManifest;
}

/** The popup path declared by whichever action key this manifest version uses. */
export function popupPath(manifest: RawManifest): string | undefined {
  return (
    manifest.action?.default_popup ??
    manifest.browser_action?.default_popup ??
    manifest.page_action?.default_popup
  );
}

export function optionsPath(manifest: RawManifest): string | undefined {
  return manifest.options_ui?.page ?? manifest.options_page;
}

export function hasServiceWorker(manifest: RawManifest): boolean {
  return Boolean(manifest.background?.service_worker);
}

/**
 * Localised manifests use `__MSG_key__` placeholders. Resolve them from `_locales` so the report
 * shows a real name rather than `__MSG_extName__`.
 */
export function resolveMessages(extensionPath: string, manifest: RawManifest, value?: string): string | undefined {
  if (!value || !value.startsWith('__MSG_')) return value;
  const key = value.slice(6, -2);
  const locale = manifest.default_locale ?? 'en';
  for (const candidate of [locale, 'en', 'en_US']) {
    const file = join(resolve(extensionPath), '_locales', candidate, 'messages.json');
    if (!existsSync(file)) continue;
    try {
      const messages = JSON.parse(readFileSync(file, 'utf8')) as Record<string, { message?: string }>;
      const message = messages[key]?.message;
      if (message) return message;
    } catch {
      /* a malformed locale file should not stop a test run */
    }
  }
  return value;
}

function stripJsonComments(text: string): string {
  return text.replace(/^\s*\/\/.*$/gm, '');
}
