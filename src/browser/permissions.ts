/**
 * Compare the permissions an extension declares against the ones it was actually seen using.
 *
 * Unjustified permissions are among the most common reasons a Chrome Web Store review stalls, and
 * they are hard to spot by reading code: a permission added during a spike stays in the manifest
 * long after the feature was cut. A linter cannot tell — the manifest is valid either way. Only
 * watching a real run can.
 *
 * The result is evidence, not a verdict. A permission used solely on a path no test exercises is
 * indistinguishable from one that is genuinely dead, so findings are phrased as "not observed"
 * and the report always states how much of the extension the run actually covered.
 */

/**
 * Permissions that gate a `chrome.*` namespace. Observing any access to the namespace is taken as
 * the permission being used.
 */
const NAMESPACE_PERMISSIONS: Record<string, string> = {
  alarms: 'alarms',
  bookmarks: 'bookmarks',
  browsingData: 'browsingData',
  contextMenus: 'contextMenus',
  cookies: 'cookies',
  debugger: 'debugger',
  declarativeNetRequest: 'declarativeNetRequest',
  desktopCapture: 'desktopCapture',
  downloads: 'downloads',
  fontSettings: 'fontSettings',
  history: 'history',
  identity: 'identity',
  idle: 'idle',
  management: 'management',
  notifications: 'notifications',
  offscreen: 'offscreen',
  pageCapture: 'pageCapture',
  power: 'power',
  privacy: 'privacy',
  proxy: 'proxy',
  readingList: 'readingList',
  scripting: 'scripting',
  search: 'search',
  sessions: 'sessions',
  sidePanel: 'sidePanel',
  storage: 'storage',
  system: 'system',
  tabGroups: 'tabGroups',
  tabs: 'tabs',
  topSites: 'topSites',
  tts: 'tts',
  webNavigation: 'webNavigation',
  webRequest: 'webRequest',
};

/** The namespaces worth instrumenting, including ones that need no permission at all. */
export const WATCHED_NAMESPACES = Object.keys(NAMESPACE_PERMISSIONS);

/**
 * Permissions with no `chrome.*` surface to watch. Their absence from a run proves nothing, so
 * they are reported separately and never suggested for removal.
 */
const UNOBSERVABLE_PERMISSIONS = new Set([
  // Grants transient host access when the user invokes the extension; no API of its own.
  'activeTab',
  'unlimitedStorage',
  'background',
  // Exercised through document.execCommand and navigator.clipboard, not chrome.*.
  'clipboardRead',
  'clipboardWrite',
  'geolocation',
  // chrome.runtime is always present, so native messaging cannot be distinguished by namespace.
  'nativeMessaging',
  'declarativeNetRequestFeedback',
  'declarativeNetRequestWithHostAccess',
]);

export type PermissionVerdict = 'used' | 'not-observed' | 'not-observable' | 'undeclared';

export interface PermissionFinding {
  permission: string;
  verdict: PermissionVerdict;
  /** Namespaces observed that justify a `used` verdict. */
  evidence?: string[];
  note?: string;
}

export interface PermissionAudit {
  findings: PermissionFinding[];
  /** Declared permissions never seen in use and observable in principle. */
  unusedCount: number;
  /** APIs used whose permission is missing from the manifest — a production bug. */
  undeclaredCount: number;
  /** Namespaces touched during the run, whether or not they needed a permission. */
  observed: string[];
  /**
   * True when the run exercised too little for a `not-observed` verdict to be meaningful.
   * Reports must say so rather than implying a permission is safe to delete.
   */
  lowCoverage: boolean;
}

export interface AuditInput {
  declared: string[];
  /** `chrome.<namespace>` names observed during the run. */
  observed: string[];
  /** Total steps executed. */
  stepCount: number;
  /**
   * Steps that actually drove the extension — clicks, typing, keypresses, menu invocations.
   * A run that only opens surfaces and reads them exercises almost no behaviour, so "not
   * observed" says far more about the tests than about the manifest.
   */
  interactiveSteps: number;
}

export function auditPermissions({
  declared,
  observed,
  stepCount,
  interactiveSteps,
}: AuditInput): PermissionAudit {
  const seen = new Set(observed);
  const declaredSet = new Set(declared);
  const findings: PermissionFinding[] = [];

  for (const permission of declared) {
    if (UNOBSERVABLE_PERMISSIONS.has(permission)) {
      findings.push({
        permission,
        verdict: 'not-observable',
        note: 'No chrome.* namespace corresponds to this permission, so a run cannot confirm its use.',
      });
      continue;
    }

    const namespaces = Object.entries(NAMESPACE_PERMISSIONS)
      .filter(([, mapped]) => mapped === permission)
      .map(([namespace]) => namespace);

    if (!namespaces.length) {
      findings.push({
        permission,
        verdict: 'not-observable',
        note: 'Not a permission pikabo knows how to observe.',
      });
      continue;
    }

    const evidence = namespaces.filter((namespace) => seen.has(namespace));
    findings.push(
      evidence.length
        ? { permission, verdict: 'used', evidence: evidence.map((n) => `chrome.${n}`) }
        : {
            permission,
            verdict: 'not-observed',
            note: `chrome.${namespaces.join(' / chrome.')} was never touched during this run.`,
          },
    );
  }

  // The reverse direction matters more: calling an API without declaring its permission fails in
  // production, where the namespace is simply undefined.
  for (const namespace of observed) {
    const permission = NAMESPACE_PERMISSIONS[namespace];
    if (!permission || declaredSet.has(permission)) continue;
    if (findings.some((f) => f.permission === permission)) continue;
    findings.push({
      permission,
      verdict: 'undeclared',
      evidence: [`chrome.${namespace}`],
      note: 'Used during the run but absent from manifest.json.',
    });
  }

  findings.sort((a, b) => order(a.verdict) - order(b.verdict) || a.permission.localeCompare(b.permission));

  return {
    findings,
    unusedCount: findings.filter((f) => f.verdict === 'not-observed').length,
    undeclaredCount: findings.filter((f) => f.verdict === 'undeclared').length,
    observed: [...seen].sort(),
    // A smoke suite generated by `explore` opens the popup and reads it; that is several steps
    // and almost no behaviour. Interaction count is the honest signal.
    lowCoverage: stepCount < 5 || interactiveSteps < 3,
  };
}

function order(verdict: PermissionVerdict): number {
  return { undeclared: 0, 'not-observed': 1, 'not-observable': 2, used: 3 }[verdict];
}

/** Namespace for a permission, when there is exactly one. Used by tests and docs. */
export function namespacesFor(permission: string): string[] {
  return Object.entries(NAMESPACE_PERMISSIONS)
    .filter(([, mapped]) => mapped === permission)
    .map(([namespace]) => namespace);
}
