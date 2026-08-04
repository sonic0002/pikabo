import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Session } from '../browser/session.js';
import { parseSuite } from '../dsl/parse.js';
import { runSuites } from '../dsl/runner.js';
import { STEP_HANDLERS } from '../dsl/steps/index.js';
import { generateSmokeSuite, suiteToYaml } from '../explore/generate.js';
import { renderMarkdown } from '../report/markdown.js';
import { writeReports } from '../run.js';

export interface McpOptions {
  defaultExtension: string;
  outDir: string;
  headless: boolean;
}

/**
 * A long-lived browser an agent can poke at across tool calls.
 *
 * The point is iteration: launch once, click around, read the console, then freeze what worked
 * into a YAML suite. Every primitive here maps to a step in the DSL, so anything discovered
 * interactively can be written down verbatim.
 */
class McpSession {
  private session?: Session;
  private shotCount = 0;
  /** Sortable, filename-safe start time, e.g. `2026-08-03T12-14-05`. */
  private readonly sessionStamp = new Date().toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, '');
  private last: unknown;
  private eventStart = 0;
  private downloadCursor = 0;

  constructor(private readonly options: McpOptions) {}

  async launch(extensionPath?: string, headless?: boolean): Promise<Record<string, unknown>> {
    await this.close();
    this.session = await Session.start({
      extensionPath: resolve(extensionPath ?? this.options.defaultExtension),
      headless: headless ?? this.options.headless,
      artifactsDir: this.options.outDir,
    });
    await this.session.drainWorkerEvents().catch(() => undefined);
    this.eventStart = this.session.lastEventSequence;
    this.downloadCursor = this.session.downloads.length;
    const ext = this.session.extension;
    return {
      id: ext.id,
      name: ext.name,
      version: ext.version,
      manifestVersion: ext.manifestVersion,
      popup: ext.popup ?? null,
      optionsPage: ext.optionsPage ?? null,
      hasServiceWorker: ext.hasServiceWorker,
      permissions: ext.permissions,
      contentScripts: ext.contentScripts,
      idSource: ext.idSource,
    };
  }

  private require(): Session {
    if (!this.session) throw new Error('No browser is running. Call ext_launch first.');
    return this.session;
  }

  /** Run any DSL step through the same handlers the file runner uses. */
  async step(action: string, options: Record<string, unknown>): Promise<unknown> {
    const session = this.require();
    const handler = STEP_HANDLERS[action];
    if (!handler) throw new Error(`Unknown step "${action}".`);
    const target = typeof options['in'] === 'string' ? String(options['in']) : session.active;
    const value = await handler({
      session,
      options,
      target,
      timeout: typeof options['timeout'] === 'number' ? options['timeout'] : 15_000,
      last: this.last,
      eventStart: this.eventStart,
      downloadStart: this.downloadCursor,
      consumeDownload: (index) => {
        this.downloadCursor = Math.max(this.downloadCursor, index + 1);
      },
      note: () => {},
      capture: (name) => this.screenshot(name, target),
    });
    if (action === 'eval') this.last = value;
    return value;
  }

  /**
   * Capture a screenshot into a directory owned by this server process.
   *
   * The counter restarts at one whenever the server does, so a flat directory would let a new
   * session overwrite the previous session's images. Scoping by start time keeps each session's
   * evidence intact, and unlike a test run this server has no natural point at which clearing
   * old output would be safe — an agent may still be reading it.
   */
  async screenshot(name?: string, context?: string): Promise<string> {
    const session = this.require();
    const dir = join(this.options.outDir, 'screenshots', `mcp-${this.sessionStamp}`);
    mkdirSync(dir, { recursive: true });
    const index = String(++this.shotCount).padStart(2, '0');
    const file = join(dir, `${index}-${(name ?? 'shot').replace(/[^\w.-]+/g, '-')}.png`);
    const page = session.page(context && context !== 'worker' ? context : session.active === 'worker' ? 'page' : session.active);
    await page.screenshot({ path: file });
    return file;
  }

  async consoleLog(): Promise<unknown[]> {
    const session = this.require();
    await session.drainWorkerConsole();
    return session.console.slice(-100);
  }

  async runSuiteText(yaml: string): Promise<string> {
    const session = this.require();
    const suite = parseSuite(yaml, 'mcp-inline.yaml');
    const result = await runSuites([{ suite, file: 'mcp-inline.yaml' }], {
      extensionPath: session.extension.path,
      outDir: this.options.outDir,
      headless: this.options.headless,
      shots: 'step-end',
    });
    await writeReports(result, this.options.outDir, { reporters: ['html', 'json', 'md'] }, () => {});
    return renderMarkdown(result);
  }

  async close(): Promise<void> {
    if (this.session) await this.session.close().catch(() => undefined);
    this.session = undefined;
    this.eventStart = 0;
    this.downloadCursor = 0;
  }
}

export async function startMcpServer(options: McpOptions): Promise<void> {
  const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const { CallToolRequestSchema, ListToolsRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');

  const state = new McpSession(options);
  const server = new Server(
    { name: 'pikabo', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  const tools = [
    {
      name: 'ext_launch',
      description:
        'Launch Chromium with an unpacked extension loaded and return the extension identity (id, popup path, options path, permissions, content scripts). Call this first.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the extension directory. Defaults to the server default.' },
          headless: { type: 'boolean', description: 'Run without a visible window. Defaults to the server default.' },
        },
      },
    },
    {
      name: 'ext_step',
      description:
        'Run one DSL step against the live browser. `action` is any step name (navigate, openPopup, openOptions, click, fill, type, press, select, waitFor, waitForDownload, assertVisible, assertText, assertStorage, assertNoConsoleErrors, eval, setStorage, clearStorage, screenshot, …) and `options` is that step\'s options bag, including `in` to choose the context (page | popup | options | worker).',
      inputSchema: {
        type: 'object',
        required: ['action'],
        properties: {
          action: { type: 'string' },
          options: { type: 'object' },
        },
      },
    },
    {
      name: 'ext_screenshot',
      description: 'Capture a screenshot of a context and return its file path.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          context: { type: 'string', description: 'page | popup | options | a named tab' },
        },
      },
    },
    {
      name: 'ext_console',
      description:
        'Return the merged console stream from every context — page, popup, options page and service worker — most recent 100 entries.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'ext_generate_suite',
      description:
        'Generate a smoke-test suite in YAML from an extension manifest, without running it. Use this as a starting point to edit.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' }, sampleUrl: { type: 'string' } },
      },
    },
    {
      name: 'ext_run_suite',
      description:
        'Run a YAML suite against the loaded extension and return a Markdown report. Writes HTML/JSON/Markdown reports to the output directory.',
      inputSchema: {
        type: 'object',
        required: ['yaml'],
        properties: { yaml: { type: 'string', description: 'Suite source in the pikabo YAML format.' } },
      },
    },
    {
      name: 'ext_close',
      description: 'Close the browser and release the profile.',
      inputSchema: { type: 'object', properties: {} },
    },
  ];

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    try {
      const result = await dispatch(request.params.name, args, state, options);
      return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = () => void state.close().finally(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function dispatch(
  name: string,
  args: Record<string, unknown>,
  state: McpSession,
  options: McpOptions,
): Promise<unknown> {
  switch (name) {
    case 'ext_launch':
      return await state.launch(args['path'] as string | undefined, args['headless'] as boolean | undefined);
    case 'ext_step':
      return (
        (await state.step(String(args['action']), (args['options'] as Record<string, unknown>) ?? {})) ?? 'ok'
      );
    case 'ext_screenshot':
      return await state.screenshot(args['name'] as string | undefined, args['context'] as string | undefined);
    case 'ext_console':
      return await state.consoleLog();
    case 'ext_generate_suite':
      return suiteToYaml(
        generateSmokeSuite(resolve((args['path'] as string) ?? options.defaultExtension), {
          sampleUrl: args['sampleUrl'] as string | undefined,
        }),
      );
    case 'ext_run_suite':
      return await state.runSuiteText(String(args['yaml']));
    case 'ext_close':
      await state.close();
      return 'closed';
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
