import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { writeJsonAtomic } from "./atomic-json.js";
import { createCliQuotaClient, resolveCliRoots } from "./cli-show.js";
import { getOpencodeRuntimeDirs } from "./opencode-runtime-paths.js";
import { getQuotaProviderShape } from "./provider-metadata.js";
import { collectQuotaRenderData } from "./quota-render-data.js";
import { resolveQuotaRuntimeContext } from "./quota-runtime-context.js";
import type { QuotaToastConfig } from "./types.js";
import { buildWidgetPayload, type WidgetPayload } from "./widget-payload.js";

const WIDGET_POSITIONS = ["top-right", "top-left", "bottom-right", "bottom-left"] as const;
type WidgetPosition = (typeof WIDGET_POSITIONS)[number];

const DEFAULT_INTERVAL_SECONDS = 60;
const DEFAULT_MARGIN = 16;
const DEFAULT_ALPHA = 0.94;

export interface RunWidgetCommandOptions {
  argv?: string[];
  cwd?: string;
  stdout?: Pick<NodeJS.WriteStream, "write">;
  stderr?: Pick<NodeJS.WriteStream, "write">;
  /** Test seam: replaces the spawned overlay process. */
  spawnOverlay?: (command: string, args: string[], options: { stdio: "inherit" }) => ChildProcess;
}

const WIDGET_USAGE = [
  "Usage:",
  "  npx @slkiser/opencode-quota widget [options]",
  "",
  "Options:",
  "  --provider <provider-id>  Show only one provider (default: all enabled)",
  "  --position <corner>       top-right | top-left | bottom-right | bottom-left",
  "  --interval <seconds>      Refresh interval (default: 60)",
  "  --margin <px>             Screen margin for the default corner (default: 16)",
  "  --alpha <0..1>            Window opacity (default: 0.94)",
  "  --x <px> --y <px>         Explicit initial position; overrides --position",
  "  --data <path>             Snapshot file path (default: XDG cache)",
  "  --state <path>            Dragged-position state file (default: XDG state)",
  "  --python <path>           Python interpreter (default: $OPENCODE_QUOTA_PYTHON or python3)",
  "  --print                   Print the snapshot JSON and exit without opening a window",
  "  --live                    Force a live provider fetch instead of cached data",
  "  --no-refresh              Write the snapshot once and keep the last data",
  "  --help, -h                Show help",
].join("\n");

type ParsedWidgetArgs =
  | {
      ok: true;
      help: boolean;
      providerId?: string;
      position: WidgetPosition;
      intervalSeconds: number;
      margin: number;
      alpha: number;
      dataPath?: string;
      statePath?: string;
      python?: string;
      title?: string;
      x?: number;
      y?: number;
      print: boolean;
      refresh: boolean;
      live: boolean;
    }
  | { ok: false; error: string };

function readValue(argv: string[], index: number, name: string): string | undefined {
  const arg = argv[index];
  if (arg === undefined) return undefined;
  if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1).trim() || undefined;
  const next = argv[index + 1];
  if (!next || next.startsWith("-")) return undefined;
  return next;
}

function parseNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseWidgetArgs(argv: string[]): ParsedWidgetArgs {
  const parsed: Extract<ParsedWidgetArgs, { ok: true }> = {
    ok: true,
    help: false,
    position: "top-right",
    intervalSeconds: DEFAULT_INTERVAL_SECONDS,
    margin: DEFAULT_MARGIN,
    alpha: DEFAULT_ALPHA,
    print: false,
    refresh: true,
    live: false,
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === undefined) continue;

    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--print") {
      parsed.print = true;
      continue;
    }
    if (arg === "--no-refresh") {
      parsed.refresh = false;
      continue;
    }
    if (arg === "--live") {
      parsed.live = true;
      continue;
    }

    if (arg === "--provider" || arg.startsWith("--provider=")) {
      const value = readValue(argv, index, "--provider");
      if (!value) return { ok: false, error: "Missing value for --provider." };
      parsed.providerId = value;
      if (arg === "--provider") index += 1;
      continue;
    }

    if (arg === "--position" || arg.startsWith("--position=")) {
      const value = readValue(argv, index, "--position");
      if (!value || !(WIDGET_POSITIONS as readonly string[]).includes(value)) {
        return { ok: false, error: `--position must be one of: ${WIDGET_POSITIONS.join(", ")}.` };
      }
      parsed.position = value as WidgetPosition;
      if (arg === "--position") index += 1;
      continue;
    }

    if (arg === "--interval" || arg.startsWith("--interval=")) {
      const value = parseNumber(readValue(argv, index, "--interval"));
      if (value === undefined || value < 1) {
        return { ok: false, error: "--interval must be a number of seconds >= 1." };
      }
      parsed.intervalSeconds = value;
      if (arg === "--interval") index += 1;
      continue;
    }

    if (arg === "--margin" || arg.startsWith("--margin=")) {
      const value = parseNumber(readValue(argv, index, "--margin"));
      if (value === undefined || value < 0) {
        return { ok: false, error: "--margin must be a non-negative number." };
      }
      parsed.margin = Math.trunc(value);
      if (arg === "--margin") index += 1;
      continue;
    }

    if (arg === "--alpha" || arg.startsWith("--alpha=")) {
      const value = parseNumber(readValue(argv, index, "--alpha"));
      if (value === undefined || value <= 0 || value > 1) {
        return { ok: false, error: "--alpha must be greater than 0 and at most 1." };
      }
      parsed.alpha = value;
      if (arg === "--alpha") index += 1;
      continue;
    }

    if (arg === "--x" || arg.startsWith("--x=")) {
      const value = parseNumber(readValue(argv, index, "--x"));
      if (value === undefined) return { ok: false, error: "Missing value for --x." };
      parsed.x = Math.trunc(value);
      if (arg === "--x") index += 1;
      continue;
    }

    if (arg === "--y" || arg.startsWith("--y=")) {
      const value = parseNumber(readValue(argv, index, "--y"));
      if (value === undefined) return { ok: false, error: "Missing value for --y." };
      parsed.y = Math.trunc(value);
      if (arg === "--y") index += 1;
      continue;
    }

    if (arg === "--data" || arg.startsWith("--data=")) {
      const value = readValue(argv, index, "--data");
      if (!value) return { ok: false, error: "Missing value for --data." };
      parsed.dataPath = value;
      if (arg === "--data") index += 1;
      continue;
    }

    if (arg === "--state" || arg.startsWith("--state=")) {
      const value = readValue(argv, index, "--state");
      if (!value) return { ok: false, error: "Missing value for --state." };
      parsed.statePath = value;
      if (arg === "--state") index += 1;
      continue;
    }

    if (arg === "--python" || arg.startsWith("--python=")) {
      const value = readValue(argv, index, "--python");
      if (!value) return { ok: false, error: "Missing value for --python." };
      parsed.python = value;
      if (arg === "--python") index += 1;
      continue;
    }

    if (arg === "--title" || arg.startsWith("--title=")) {
      const value = readValue(argv, index, "--title");
      if (!value) return { ok: false, error: "Missing value for --title." };
      parsed.title = value;
      if (arg === "--title") index += 1;
      continue;
    }

    return { ok: false, error: `Unknown option: ${arg}` };
  }

  return parsed;
}

function writeLine(stream: Pick<NodeJS.WriteStream, "write">, message: string): void {
  stream.write(message.endsWith("\n") ? message : `${message}\n`);
}

function resolveOverlayScriptPath(): string {
  return fileURLToPath(new URL("../widget/overlay.py", import.meta.url));
}

function buildWidgetConfig(config: QuotaToastConfig, providerId?: string): QuotaToastConfig {
  return {
    ...config,
    enabledProviders: providerId ? [providerId] : config.enabledProviders,
    // The overlay always shows the canonical OpenCode Go window set so users
    // get 5h / weekly / monthly even when the compact line is single-window.
    opencodeGoWindows: ["rolling", "weekly", "monthly"],
    showSessionTokens: false,
  };
}

export async function runWidgetCommand(options: RunWidgetCommandOptions = {}): Promise<number> {
  const argv = options.argv ?? process.argv.slice(3);
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  const parsed = parseWidgetArgs(argv);
  if (!parsed.ok) {
    writeLine(stderr, parsed.error);
    writeLine(stderr, WIDGET_USAGE);
    return 1;
  }
  if (parsed.help) {
    writeLine(stdout, WIDGET_USAGE);
    return 0;
  }

  const providerId = parsed.providerId ? getQuotaProviderShape(parsed.providerId)?.id : undefined;
  if (parsed.providerId && !providerId) {
    writeLine(stderr, `Unknown provider: ${parsed.providerId}`);
    return 1;
  }

  const dirs = getOpencodeRuntimeDirs();
  const dataPath = parsed.dataPath ?? join(dirs.cacheDir, "quota-widget.json");
  const statePath = parsed.statePath ?? join(dirs.stateDir, "quota-widget-state.json");

  let runtime: Awaited<ReturnType<typeof resolveQuotaRuntimeContext>>;
  try {
    const roots = resolveCliRoots(options.cwd ?? process.cwd());
    const client = createCliQuotaClient({ configRootDir: roots.configRoot });
    runtime = await resolveQuotaRuntimeContext({ client, roots, includeSessionMeta: false });
  } catch (error) {
    writeLine(
      stderr,
      `Failed to load quota config: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }

  if (!runtime.config.enabled) {
    writeLine(stderr, "Quota disabled in config (enabled: false).");
    return 1;
  }

  const config = buildWidgetConfig(runtime.config, providerId);

  const collect = async (): Promise<WidgetPayload> => {
    const result = await collectQuotaRenderData({
      client: runtime.client,
      resolveRuntimeProviderIds: runtime.resolveRuntimeProviderIds,
      config,
      configMeta: runtime.configMeta,
      surfaceExplicitProviderIssues: false,
      formatStyle: "allWindows",
      providers: runtime.providers,
      includeAllWindowsData: true,
      ...(parsed.live ? { bypassProviderCache: true } : {}),
    });
    return buildWidgetPayload({
      data: result.allWindowsData ?? result.data,
      ...(providerId ? { providerId } : {}),
    });
  };

  const refreshSnapshot = async (): Promise<WidgetPayload> => {
    const payload = await collect();
    await writeJsonAtomic(dataPath, payload, { trailingNewline: true });
    return payload;
  };

  let payload: WidgetPayload;
  try {
    payload = await refreshSnapshot();
  } catch (error) {
    writeLine(
      stderr,
      `Failed to collect quota: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }

  if (parsed.print) {
    writeLine(stdout, JSON.stringify(payload, null, 2));
    return 0;
  }

  const overlayScript = resolveOverlayScriptPath();
  if (!existsSync(overlayScript)) {
    writeLine(stderr, `Overlay script not found: ${overlayScript}`);
    return 1;
  }

  const python = parsed.python ?? process.env.OPENCODE_QUOTA_PYTHON ?? "python3";
  const overlayArgs = [
    overlayScript,
    "--data",
    dataPath,
    "--interval",
    String(parsed.intervalSeconds),
    "--position",
    parsed.position,
    "--state",
    statePath,
    "--margin",
    String(parsed.margin),
    "--alpha",
    String(parsed.alpha),
    ...(parsed.title ? ["--title", parsed.title] : []),
    ...(parsed.x !== undefined ? ["--x", String(parsed.x)] : []),
    ...(parsed.y !== undefined ? ["--y", String(parsed.y)] : []),
  ];

  const spawnOverlay =
    options.spawnOverlay ??
    ((command: string, args: string[], spawnOptions: { stdio: "inherit" }) =>
      spawn(command, args, spawnOptions));
  const child = spawnOverlay(python, overlayArgs, { stdio: "inherit" });

  let refreshTimer: NodeJS.Timeout | undefined;
  if (parsed.refresh) {
    refreshTimer = setInterval(() => {
      void refreshSnapshot().catch((error) => {
        console.warn(
          `[opencode-quota] widget refresh failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }, Math.max(1, parsed.intervalSeconds) * 1000);
    refreshTimer.unref();
  }

  return await new Promise<number>((resolve) => {
    const finish = (code: number): void => {
      if (refreshTimer) clearInterval(refreshTimer);
      resolve(code);
    };
    child.on("error", (error) => {
      writeLine(stderr, `Failed to start overlay: ${error.message}`);
      finish(1);
    });
    child.on("exit", (code) => finish(code ?? 0));
  });
}
