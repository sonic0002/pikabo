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
  close(): void;
}

interface CdpMessage {
  id?: number;
  method?: string;
  sessionId?: string;
  params?: Record<string, unknown>;
}

export interface BrowserSessionOptions {
  /**
   * Directory every download should land in, whatever started it. Chrome sends downloads begun
   * by `chrome.downloads.download()` straight to disk without any page involvement, so this is
   * the only way to see files an extension saves from its service worker.
   */
  downloadPath?: string;
}

export async function attachWorkerConsole(
  profileDir: string,
  sink: (entry: ConsoleEntry) => void,
  options: BrowserSessionOptions = {},
): Promise<CdpConsole | undefined> {
  if (typeof WebSocket === 'undefined') return undefined;

  const port = await readDevToolsPort(profileDir);
  if (!port) return undefined;

  const wsUrl = await browserWebSocketUrl(port);
  if (!wsUrl) return undefined;

  return await new Promise<CdpConsole | undefined>((resolve) => {
    let settled = false;
    const socket = new WebSocket(wsUrl);
    const workerSessions = new Set<string>();
    let nextId = 0;

    const send = (method: string, params: unknown = {}, sessionId?: string) => {
      try {
        socket.send(JSON.stringify({ id: ++nextId, method, params, sessionId }));
      } catch {
        /* the socket closed underneath us; nothing to recover */
      }
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
      send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
      if (options.downloadPath) {
        send('Browser.setDownloadBehavior', {
          behavior: 'allow',
          downloadPath: options.downloadPath,
          eventsEnabled: true,
        });
      }
      clearTimeout(timer);
      finish({
        close() {
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

    socket.onmessage = (event) => {
      let message: CdpMessage;
      try {
        message = JSON.parse(String(event.data)) as CdpMessage;
      } catch {
        return;
      }

      if (message.method === 'Target.attachedToTarget') {
        const params = message.params as { sessionId: string; targetInfo: { type: string } };
        const isWorker = params.targetInfo.type === 'service_worker';
        if (isWorker) {
          workerSessions.add(params.sessionId);
          send('Runtime.enable', {}, params.sessionId);
        }
        // Release every target, worker or not — a target left waiting never runs.
        send('Runtime.runIfWaitingForDebugger', {}, params.sessionId);
        return;
      }

      if (message.method === 'Target.detachedFromTarget') {
        const params = message.params as { sessionId?: string };
        if (params.sessionId) workerSessions.delete(params.sessionId);
        return;
      }

      if (!message.sessionId || !workerSessions.has(message.sessionId)) return;

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
