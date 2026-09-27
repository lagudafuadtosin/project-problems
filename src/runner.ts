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

export interface RunnerEvents {
  onStart(): void;
  onProblems(problems: TscProblem[]): void;
  onLog(line: string): void;
  onExit(code: number | null): void;
}

// One tsc --watch process for one tsconfig.
export class ProjectRunner {
  private child: ChildProcess | null = null;
  private stopped = false;

  constructor(
    readonly tsconfig: string,
    private readonly compiler: Compiler,
    private readonly cacheDir: string,
    private readonly events: RunnerEvents,
  ) {}

  start(): void {
    // Incremental checking keeps a cache file. Many projects name one inside
    // the repo (Vite puts it in node_modules/.tmp); it is redirected to the
    // extension's own per-user storage so nothing is written into the project,
    // and nothing into a shared temp folder another user could tamper with.
    mkdirSync(this.cacheDir, { recursive: true });
    const cacheFile = path.join(this.cacheDir, createHash("sha256").update(this.tsconfig).digest("hex").slice(0, 16) + ".tsbuildinfo");
    const args = [
      this.compiler.script,
      "--noEmit",
      "--watch",
      "--preserveWatchOutput",
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
    // VS Code's own executable runs as plain Node with this variable set, so
    // the extension needs no separate Node install. No shell is involved.
    this.child = spawn(process.execPath, args, {
      cwd: path.dirname(this.tsconfig),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      windowsHide: true,
      // Its own process group on macOS and Linux, so stop() can end any
      // compiler it starts as well.
      detached: process.platform !== "win32",
    });
    this.child.stdout?.setEncoding("utf8");
    this.child.stderr?.setEncoding("utf8");
    this.child.stdout?.on("data", (d: string) => parser.push(d));
    this.child.stderr?.on("data", (d: string) => this.events.onLog(d.trimEnd()));
    this.child.on("error", (err) => this.events.onLog(`could not start tsc: ${err.message}`));
    this.child.on("exit", (code) => {
      this.child = null;
      if (!this.stopped) this.events.onExit(code);
    });
  }

  stop(): void {
    this.stopped = true;
    const child = this.child;
    this.child = null;
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
}
