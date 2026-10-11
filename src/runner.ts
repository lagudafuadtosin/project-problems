import { spawn, execFile, ChildProcess } from "node:child_process";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { WatchParser, TscProblem } from "./parse";
import { Compiler } from "./tsconfig";

// TS6305 only says a referenced project's output has not been built yet,
// which is always true when checking without building. Every other message,
// including real config errors, is passed through: hiding those would report
// a project as clean when it was never checked.
const REFERENCE_NOISE = new Set(["TS6305"]);

// A checker printing more than this has gone wrong; the rest is dropped so
// memory stays flat.
const MAX_OUTPUT = 64 * 1024 * 1024;

export interface RunnerEvents {
  onStart(): void;
  onProblems(problems: TscProblem[]): void;
  onLog(line: string): void;
  onExit(code: number | null): void;
}

// VS Code's own executable runs as plain Node with this variable set, so the
// extension needs no separate Node install. No shell is involved anywhere, so
// a folder name can never be run as a command.
function runNode(script: string, args: string[], cwd: string, extraEnv: Record<string, string> = {}): ChildProcess {
  return spawn(process.execPath, [script, ...args], {
    cwd,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ...extraEnv },
    windowsHide: true,
    // Its own process group on macOS and Linux, so stopping it ends any
    // process it starts as well.
    detached: process.platform !== "win32",
  });
}

function killTree(child: ChildProcess | null): void {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    // TypeScript 7 starts a native compiler as a child process; /T ends the whole tree.
    execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {});
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill();
    }
  }
}

// The compiler cache for one project, in the extension's own per-user storage,
// so nothing is written into the project and nothing into a shared temp folder
// another user could tamper with.
export function cacheFileFor(cacheDir: string, key: string, ext: string): string {
  mkdirSync(cacheDir, { recursive: true });
  return path.join(cacheDir, createHash("sha256").update(key).digest("hex").slice(0, 16) + ext);
}

// tsc (or vue-tsc, which prints the same) for one tsconfig: kept running in
// watch mode, or run once when checking on save or by hand.
export class ProjectRunner {
  private child: ChildProcess | null = null;
  private stopped = false;
  private pending = false;

  constructor(
    readonly tsconfig: string,
    private readonly compiler: Compiler,
    private readonly cacheDir: string,
    private readonly events: RunnerEvents,
    readonly once = false,
  ) {}

  get running(): boolean {
    return this.child !== null;
  }

  start(): void {
    // A run asked for while one is going waits and runs once more at the end,
    // so a save during a check is never lost.
    if (this.child) {
      this.pending = true;
      return;
    }
    this.stopped = false;
    const cacheFile = cacheFileFor(this.cacheDir, this.tsconfig, ".tsbuildinfo");
    const args = [
      "--noEmit",
      ...(this.once ? [] : ["--watch", "--preserveWatchOutput"]),
      "--pretty", "false",
      "--incremental",
      "--tsBuildInfoFile", cacheFile,
      "-p", this.tsconfig,
    ];
    const parser = new WatchParser(
      (problems) => {
        const unbuilt = problems.filter((p) => REFERENCE_NOISE.has(p.code)).length;
        if (unbuilt) this.events.onLog(`${unbuilt} import(s) point at referenced projects that have not been built, so their types are not checked across projects. Build once (tsc -b) for full checking.`);
        this.events.onProblems(problems.filter((p) => !REFERENCE_NOISE.has(p.code)));
      },
      () => this.events.onStart(),
    );
    if (this.once) this.events.onStart();
    const child = runNode(this.compiler.script, args, path.dirname(this.tsconfig));
    this.child = child;
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => parser.push(d));
    child.stderr?.on("data", (d: string) => this.events.onLog(d.trimEnd()));
    child.on("error", (err) => this.events.onLog(`could not start the checker: ${err.message}`));
    child.on("exit", (code) => {
      if (this.child === child) this.child = null;
      if (this.stopped) return;
      if (this.once) {
        // 0 is clean and 1 or 2 means errors were found: all normal endings.
        parser.finish();
        if (this.pending) {
          this.pending = false;
          this.start();
        }
        return;
      }
      this.events.onExit(code);
    });
  }

  stop(): void {
    this.stopped = true;
    this.pending = false;
    const child = this.child;
    this.child = null;
    killTree(child);
  }
}

// A checker that runs once and prints its findings when it ends: svelte-check,
// astro check and ESLint. Run again on save, or by hand.
export class ToolRunner {
  private child: ChildProcess | null = null;
  private stopped = false;
  private pending = false;

  constructor(
    readonly key: string,
    private readonly script: string,
    private readonly args: string[],
    readonly cwd: string,
    private readonly parse: (output: string) => TscProblem[],
    private readonly events: Omit<RunnerEvents, "onExit">,
    private readonly env: Record<string, string> = {},
  ) {}

  get running(): boolean {
    return this.child !== null;
  }

  start(): void {
    if (this.child) {
      this.pending = true;
      return;
    }
    this.stopped = false;
    this.events.onStart();
    let out = "";
    let err = "";
    const child = runNode(this.script, this.args, this.cwd, this.env);
    this.child = child;
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => {
      if (out.length < MAX_OUTPUT) out += d;
    });
    child.stderr?.on("data", (d: string) => {
      err = (err + d).slice(-4000);
    });
    child.on("error", (e) => this.events.onLog(`could not start the checker: ${e.message}`));
    child.on("exit", (code) => {
      if (this.child === child) this.child = null;
      if (this.stopped) return;
      const problems = this.parse(out);
      // Exit codes above 1 with nothing parsed mean the checker itself failed
      // (a broken config, say); that is said in the log rather than shown as clean.
      if (problems.length === 0 && (code ?? 0) > 1 && err.trim()) this.events.onLog(err.trim());
      this.events.onProblems(problems);
      if (this.pending) {
        this.pending = false;
        this.start();
      }
    });
  }

  stop(): void {
    this.stopped = true;
    this.pending = false;
    const child = this.child;
    this.child = null;
    killTree(child);
  }
}
