import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ConsoleEntry } from '../types.js';

/**
 * Capture the service worker's console over the DevTools protocol.
 *
 * Wrapping `console` from inside the worker — the obvious approach — misses everything logged
 * before the wrapper installs, which is exactly the window where a broken background script
 * fails. Attaching at the browser target instead gets `Runtime.enable`'s replay of the buffered
 * messages, so errors thrown on the worker's very first line still show up, with stack traces.
 *
 * Auto-attach also covers worker restarts, so `reloadExtension` needs no special handling.
 *
 * Every failure here is non-fatal: the caller falls back to wrapping `console` in-worker.
 */

export interface CdpConsole {
  evaluateExtensionTarget(path: string, functionSource: string, args: unknown, timeout?: number): Promise<unknown>;
  close(): void;
}

export interface WorkerLifecycleEntry {
  state: 'started' | 'stopped';
  versionId: string;
  scriptUrl: string;
  targetId?: string;
  timestamp: number;
}

export interface BrowserDownloadEntry {
  guid: string;
  suggestedFilename: string;
  url?: string;
}

interface CdpMessage {
  id?: number;
  method?: string;
  sessionId?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { message?: string };
}

export interface BrowserSessionOptions {
  /**
   * Directory every download should land in, whatever started it. Chrome sends downloads begun
   * by `chrome.downloads.download()` straight to disk without any page involvement, so this is
   * the only way to see files an extension saves from its service worker.
   */
  downloadPath?: string;
  /** Only lifecycle events for this extension origin are surfaced. */
  workerOrigin?: string;
  onWorkerLifecycle?: (entry: WorkerLifecycleEntry) => void;
  onDownloadWillBegin?: (entry: BrowserDownloadEntry) => void;
}

export async function attachWorkerConsole(
  profileDir: string,
  sink: (entry: ConsoleEntry) => void,
  options: BrowserSessionOptions = {},
): Promise<CdpConsole | undefined> {
  // Node exposes a global WebSocket from 22 onward. Returning "no console" on an older runtime
  // made a broken extension look clean, which is the one failure this tool must never produce.
  if (typeof WebSocket === 'undefined') {
    throw new Error(
      `This runtime has no global WebSocket, so the extension's service-worker console cannot be ` +
        `captured. Node 22 or newer is required (running ${process.versions.node}). ` +
        `Pass debugPort: false through the library API to run without console capture.`,
    );
  }

  const port = await readDevToolsPort(profileDir);
  if (!port) return undefined;

  const wsUrl = await browserWebSocketUrl(port);
  if (!wsUrl) return undefined;

  return await new Promise<CdpConsole | undefined>((resolve) => {
    let settled = false;
    const socket = new WebSocket(wsUrl);
    const workerSessions = new Set<string>();
    const targetSessionById = new Map<string, string>();
    const extensionTargets = new Map<string, { sessionId: string; url: string; type: string }>();
    const workerTargets = new Map<string, { scriptUrl: string; sessionId: string }>();
    const workerTargetBySession = new Map<string, string>();
    const runningScripts = new Set<string>();
    const workerVersions = new Map<
      string,
      { scriptUrl: string; targetId?: string; runningStatus: string }
    >();
    const pending = new Map<
      number,
      { resolve: (value: unknown) => void; reject: (error: Error) => void }
    >();
    let nextId = 0;

    const send = (method: string, params: unknown = {}, sessionId?: string): Promise<unknown> => {
      const id = ++nextId;
      return new Promise((resolveCommand, rejectCommand) => {
        pending.set(id, { resolve: resolveCommand, reject: rejectCommand });
        try {
          socket.send(JSON.stringify({ id, method, params, sessionId }));
        } catch (error) {
          pending.delete(id);
          rejectCommand(error instanceof Error ? error : new Error(String(error)));
        }
      });
    };

    // Setup commands are best-effort. Keeping their rejected promises handled also prevents a
    // browser closing during teardown from producing an unhandled rejection in the test process.
    const notify = (method: string, params: unknown = {}, sessionId?: string) => {
      void send(method, params, sessionId).catch(() => undefined);
    };

    const belongsToExtension = (scriptUrl: string) =>
      !options.workerOrigin || scriptUrl.startsWith(`${options.workerOrigin}/`);

    const emitLifecycle = (
      state: WorkerLifecycleEntry['state'],
      versionId: string,
      scriptUrl: string,
      targetId?: string,
    ) => {
      const running = runningScripts.has(scriptUrl);
      if ((state === 'started' && running) || (state === 'stopped' && !running)) return;
      if (state === 'started') runningScripts.add(scriptUrl);
      else runningScripts.delete(scriptUrl);
      options.onWorkerLifecycle?.({ state, versionId, scriptUrl, targetId, timestamp: Date.now() });
    };

    const finish = (value: CdpConsole | undefined) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const timer = setTimeout(() => finish(undefined), 4_000);

    socket.onopen = () => {
      // `flatten` routes nested sessions over this one connection; `waitForDebuggerOnStart`
      // holds each new target until it is released below, so nothing runs unobserved.
      notify('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
      notify('Target.setDiscoverTargets', { discover: true });
      notify('ServiceWorker.enable');
      if (options.downloadPath) {
        notify('Browser.setDownloadBehavior', {
          // Chrome otherwise gives simultaneous extension downloads the same flattened name and
          // one transfer can overwrite the other. GUID names are collision-free; Session maps
          // each GUID back to the extension-requested filename by download id.
          behavior: 'allowAndName',
          downloadPath: options.downloadPath,
          eventsEnabled: true,
        });
      }
      clearTimeout(timer);
      finish({
        async evaluateExtensionTarget(path, functionSource, args, timeout = 10_000) {
          const suffix = `/${path.replace(/^\/+/, '')}`;
          const deadline = Date.now() + timeout;
          let target: { sessionId: string; url: string; type: string } | undefined;
          while (Date.now() < deadline) {
            target = [...extensionTargets.values()].find((candidate) => {
              try {
                return new URL(candidate.url).pathname === suffix;
              } catch {
                return candidate.url.endsWith(suffix);
              }
            });
            if (target) break;
            await new Promise((resolveTarget) => setTimeout(resolveTarget, 50));
          }
          if (!target) throw new Error(`No live extension target exists for ${path}.`);
          const expression = `(${functionSource})(${JSON.stringify(args)})`;
          const response = (await send(
            'Runtime.evaluate',
            { expression, awaitPromise: true, returnByValue: true },
            target.sessionId,
          )) as {
            result?: { value?: unknown; description?: string };
            exceptionDetails?: { text?: string; exception?: { description?: string } };
          };
          if (response.exceptionDetails) {
            throw new Error(
              response.exceptionDetails.exception?.description ??
                response.exceptionDetails.text ??
                `Evaluation failed in ${path}.`,
            );
          }
          return response.result?.value;
        },
        close() {
          for (const request of pending.values()) request.reject(new Error('DevTools connection closed'));
          pending.clear();
          try {
            socket.close();
          } catch {
            /* already gone */
          }
        },
      });
    };

    socket.onerror = () => {
      clearTimeout(timer);
      finish(undefined);
    };
    socket.onclose = () => {
      for (const request of pending.values()) request.reject(new Error('DevTools connection closed'));
      pending.clear();
    };

    socket.onmessage = (event) => {
      let message: CdpMessage;
      try {
        message = JSON.parse(String(event.data)) as CdpMessage;
      } catch {
        return;
      }

      if (message.id != null) {
        const request = pending.get(message.id);
        if (!request) return;
        pending.delete(message.id);
        if (message.error) request.reject(new Error(message.error.message ?? 'DevTools command failed'));
        else request.resolve(message.result);
        return;
      }

      if (message.method === 'ServiceWorker.workerVersionUpdated') {
        const params = message.params as {
          versions?: {
            versionId: string;
            scriptURL: string;
            runningStatus: 'stopped' | 'starting' | 'running' | 'stopping';
            targetId?: string;
          }[];
        };
        for (const version of params.versions ?? []) {
          if (!belongsToExtension(version.scriptURL)) continue;
          const previous = workerVersions.get(version.versionId);
          workerVersions.set(version.versionId, {
            scriptUrl: version.scriptURL,
            targetId: version.targetId,
            runningStatus: version.runningStatus,
          });
          const started = version.runningStatus === 'running' && previous?.runningStatus !== 'running';
          const stopped = version.runningStatus === 'stopped' && previous?.runningStatus !== 'stopped';
          if (started || stopped) {
            emitLifecycle(
              started ? 'started' : 'stopped',
              version.versionId,
              version.scriptURL,
              version.targetId,
            );
          }
        }
        return;
      }

      if (message.method === 'Browser.downloadWillBegin') {
        const params = message.params as { guid?: string; suggestedFilename?: string; url?: string };
        if (params.guid && params.suggestedFilename) {
          options.onDownloadWillBegin?.({
            guid: params.guid,
            suggestedFilename: params.suggestedFilename,
            url: params.url,
          });
        }
        return;
      }

      if (message.method === 'Target.attachedToTarget') {
        const params = message.params as {
          sessionId: string;
          targetInfo: { type: string; targetId: string; url: string };
        };
        const isWorker = params.targetInfo.type === 'service_worker';
        targetSessionById.set(params.targetInfo.targetId, params.sessionId);
        if (belongsToExtension(params.targetInfo.url)) {
          extensionTargets.set(params.targetInfo.targetId, {
            sessionId: params.sessionId,
            url: params.targetInfo.url,
            type: params.targetInfo.type,
          });
          if (!isWorker) notify('Runtime.enable', {}, params.sessionId);
        }
        if (isWorker) {
          workerSessions.add(params.sessionId);
          if (belongsToExtension(params.targetInfo.url)) {
            workerTargets.set(params.targetInfo.targetId, {
              scriptUrl: params.targetInfo.url,
              sessionId: params.sessionId,
            });
            workerTargetBySession.set(params.sessionId, params.targetInfo.targetId);
            emitLifecycle('started', params.targetInfo.targetId, params.targetInfo.url, params.targetInfo.targetId);
          }
          notify('Runtime.enable', {}, params.sessionId);
        }
        // Release every target, worker or not — a target left waiting never runs.
        notify('Runtime.runIfWaitingForDebugger', {}, params.sessionId);
        return;
      }

      if (message.method === 'Target.targetInfoChanged') {
        const params = message.params as {
          targetInfo?: { targetId: string; type: string; url: string };
        };
        const info = params.targetInfo;
        if (!info) return;
        const sessionId = targetSessionById.get(info.targetId);
        if (sessionId && belongsToExtension(info.url)) {
          extensionTargets.set(info.targetId, { sessionId, url: info.url, type: info.type });
          notify('Runtime.enable', {}, sessionId);
        } else if (!belongsToExtension(info.url)) {
          extensionTargets.delete(info.targetId);
        }
        return;
      }

      if (message.method === 'Target.detachedFromTarget') {
        const params = message.params as { sessionId?: string };
        if (params.sessionId) {
          const detachedTargetId = [...targetSessionById].find(([, sessionId]) => sessionId === params.sessionId)?.[0];
          if (detachedTargetId) {
            targetSessionById.delete(detachedTargetId);
            extensionTargets.delete(detachedTargetId);
          }
          workerSessions.delete(params.sessionId);
          const targetId = workerTargetBySession.get(params.sessionId);
          workerTargetBySession.delete(params.sessionId);
          // Detachment only means this observer released the target; Target.targetDestroyed or
          // ServiceWorker.workerVersionUpdated is the authoritative stop boundary.
          if (targetId && workerTargets.get(targetId)?.sessionId === params.sessionId) {
            const target = workerTargets.get(targetId)!;
            workerTargets.set(targetId, { ...target, sessionId: '' });
          }
        }
        return;
      }

      if (message.method === 'Target.targetDestroyed') {
        const params = message.params as { targetId?: string };
        if (!params.targetId) return;
        const target = workerTargets.get(params.targetId);
        targetSessionById.delete(params.targetId);
        extensionTargets.delete(params.targetId);
        if (!target) return;
        workerTargets.delete(params.targetId);
        if (![...workerTargets.values()].some((candidate) => candidate.scriptUrl === target.scriptUrl)) {
          emitLifecycle('stopped', params.targetId, target.scriptUrl, params.targetId);
        }
        return;
      }

      if (!message.sessionId || !workerSessions.has(message.sessionId)) return;

      if (message.method === 'Runtime.executionContextsCleared') {
        const targetId = workerTargetBySession.get(message.sessionId);
        const target = targetId ? workerTargets.get(targetId) : undefined;
        if (target) emitLifecycle('stopped', targetId!, target.scriptUrl, targetId);
        return;
      }

      if (message.method === 'Runtime.executionContextCreated') {
        const targetId = workerTargetBySession.get(message.sessionId);
        const target = targetId ? workerTargets.get(targetId) : undefined;
        if (target) emitLifecycle('started', targetId!, target.scriptUrl, targetId);
        return;
      }

      if (message.method === 'Runtime.consoleAPICalled') {
        const params = message.params as { type: string; args?: RemoteObject[]; timestamp?: number };
        sink({
          context: 'worker',
          type: normaliseType(params.type),
          text: (params.args ?? []).map(describeRemoteObject).join(' '),
          timestamp: params.timestamp ? Math.round(params.timestamp) : Date.now(),
        });
      } else if (message.method === 'Runtime.exceptionThrown') {
        const params = message.params as {
          timestamp?: number;
          exceptionDetails?: {
            text?: string;
            exception?: RemoteObject;
            url?: string;
            lineNumber?: number;
            columnNumber?: number;
          };
        };
        const details = params.exceptionDetails;
        const text =
          describeRemoteObject(details?.exception) || details?.text || 'Uncaught exception in service worker';
        sink({
          context: 'worker',
          type: 'error',
          text,
          timestamp: params.timestamp ? Math.round(params.timestamp) : Date.now(),
          location:
            details?.url != null ? `${details.url}:${details.lineNumber ?? 0}:${details.columnNumber ?? 0}` : undefined,
        });
      }
    };
  });
}

interface RemoteObject {
  type?: string;
  subtype?: string;
  value?: unknown;
  description?: string;
  preview?: { properties?: { name: string; value?: string }[] };
}

function describeRemoteObject(object: RemoteObject | undefined): string {
  if (!object) return '';
  if (object.value !== undefined) {
    return typeof object.value === 'string' ? object.value : JSON.stringify(object.value);
  }
  if (object.description) return object.description;
  const properties = object.preview?.properties;
  if (properties?.length) {
    return `{ ${properties.map((p) => `${p.name}: ${p.value ?? ''}`).join(', ')} }`;
  }
  return object.type ?? '';
}

/** CDP uses `warning`; the rest of the tool uses the console's own `warn`. */
function normaliseType(type: string): string {
  return type === 'warning' ? 'warn' : type;
}

/** Chrome writes the chosen port into the profile once the debugging server is listening. */
async function readDevToolsPort(profileDir: string, timeoutMs = 5_000): Promise<string | undefined> {
  const file = join(profileDir, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const port = readFileSync(file, 'utf8').split('\n')[0]?.trim();
      if (port) return port;
    } catch {
      /* not written yet */
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return undefined;
}

async function browserWebSocketUrl(port: string): Promise<string | undefined> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`);
    const body = (await response.json()) as { webSocketDebuggerUrl?: string };
    return body.webSocketDebuggerUrl;
  } catch {
    return undefined;
  }
}
