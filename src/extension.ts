import * as vscode from "vscode";
import * as path from "node:path";
import { TscProblem } from "./parse";
import { parseAstroCheck, parseEslintJson, parseSvelteCheck } from "./parse-tools";
import { cacheFileFor, ProjectRunner, ToolRunner } from "./runner";
import { Checker, findChecker, findEslint, globToRegExp, projectConfigs } from "./tsconfig";

// Project Problems: checks every project in the workspace with the project's
// own checker (tsc, or vue-tsc, svelte-check or astro check for those
// frameworks, and ESLint if asked) and puts every problem in the Problems
// panel, including files that are not open. Files that are open are left to
// the editor's own checking where there is some, so nothing is listed twice.

const SOURCE = "Project Problems";
const RESTART_AFTER_CRASH_MS = 5000;
const MAX_RESTARTS = 3;
const SAVE_DELAY_MS = 800;

type Mode = "watch" | "onSave" | "manual";
type Runner = ProjectRunner | ToolRunner;

// Files a save of which can change what the checkers report.
const CHECKED = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|vue|svelte|astro|json)$/i;

// The editor extensions that already check a file of this kind while it is
// open. When one is installed, Project Problems leaves open files to it; when
// none is, it shows them too, so an open file is never left unchecked.
const COVERED_WHEN_OPEN: { test: RegExp; extensions: string[] }[] = [
  { test: /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i, extensions: [] }, // VS Code's own TypeScript support
  { test: /\.vue$/i, extensions: ["vue.volar"] },
  { test: /\.svelte$/i, extensions: ["svelte.svelte-vscode"] },
  { test: /\.astro$/i, extensions: ["astro-build.astro-vscode"] },
];

export function activate(context: vscode.ExtensionContext): void {
  const controller = new Controller(context);
  context.subscriptions.push(controller);
  void controller.start();
}

export function deactivate(): void {
  // Controller.dispose runs through context.subscriptions.
}

class Controller implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection("project-problems");
  private readonly output = vscode.window.createOutputChannel("Project Problems");
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  private readonly disposables: vscode.Disposable[] = [];
  private runners: Runner[] = [];
  // Latest problems per runner, keyed by file URI.
  private readonly byRunner = new Map<string, Map<string, vscode.Diagnostic[]>>();
  // Which runners report ESLint, so open files can be left to the ESLint extension.
  private readonly eslintKeys = new Set<string>();
  private readonly checking = new Set<string>();
  private paused = false;
  private restartTimer: NodeJS.Timeout | undefined;
  private saveTimer: NodeJS.Timeout | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.status.command = "projectProblems.showOutput";
    this.disposables.push(
      this.collection,
      this.output,
      this.status,
      vscode.commands.registerCommand("projectProblems.recheck", () => this.start(true)),
      vscode.commands.registerCommand("projectProblems.toggle", () => this.toggle()),
      vscode.commands.registerCommand("projectProblems.clear", () => this.clear()),
      vscode.commands.registerCommand("projectProblems.showOutput", () => this.output.show(true)),
      vscode.window.tabGroups.onDidChangeTabs(() => this.publish()),
      vscode.extensions.onDidChange(() => this.publish()),
      vscode.workspace.onDidSaveTextDocument((doc) => this.onSave(doc)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("projectProblems")) this.scheduleRestart();
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.scheduleRestart()),
      vscode.workspace.onDidGrantWorkspaceTrust(() => this.scheduleRestart()),
    );
    // A config added, removed or edited changes what there is to check.
    const watcher = vscode.workspace.createFileSystemWatcher("**/{tsconfig*.json,svelte.config.*,astro.config.*,eslint.config.*,.eslintrc*}");
    watcher.onDidCreate(() => this.scheduleRestart());
    watcher.onDidDelete(() => this.scheduleRestart());
    watcher.onDidChange(() => this.scheduleRestart());
    this.disposables.push(watcher);
  }

  private get mode(): Mode {
    const m = vscode.workspace.getConfiguration("projectProblems").get<string>("mode", "watch");
    return m === "onSave" || m === "manual" ? m : "watch";
  }

  // byHand is true for the Recheck command.
  async start(byHand = false): Promise<void> {
    this.stopAll();
    const config = vscode.workspace.getConfiguration("projectProblems");
    if (!config.get<boolean>("enable", true) || this.paused) {
      this.setStatus();
      return;
    }
    if (!vscode.workspace.isTrusted) {
      this.log("This folder is not trusted, so nothing is checked. Trust it to start.");
      this.setStatus();
      return;
    }
    const mode = this.mode;
    const exclude = config.get<string[]>("exclude", []);
    const max = config.get<number>("maxProjects", 20);
    const excludeGlob = exclude.length ? `{${exclude.join(",")}}` : undefined;
    const found = await vscode.workspace.findFiles("**/tsconfig.json", excludeGlob);
    // Shallow projects first, so the main app is checked before nested ones
    // when there are more projects than the limit.
    const roots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    const configs = projectConfigs(found.map((u) => u.fsPath), roots)
      .filter((p) => !isExcluded(p, exclude))
      .sort((a, b) => a.split(path.sep).length - b.split(path.sep).length || a.localeCompare(b));
    if (configs.length > max) {
      this.log(`${configs.length} projects found; checking the first ${max}. Raise projectProblems.maxProjects to check more.`);
    }
    // svelte-check and astro check cover a whole project folder, so a folder
    // with several tsconfigs gets one of them, not one per config.
    const toolFolders = new Set<string>();
    for (const tsconfig of configs.slice(0, max)) this.addProject(tsconfig, roots, mode, toolFolders);
    if (config.get<boolean>("eslint.enable", false)) {
      for (const root of roots) this.addEslint(root, roots);
    }
    if (this.runners.length === 0) {
      this.log(configs.length === 0 ? "No tsconfig.json found in this workspace." : "Nothing could be checked. See the lines above for why.");
      this.setStatus();
      return;
    }
    // Watch-mode compilers always start. One-off checks run now, except in
    // manual mode, where they run on a recheck by hand and, unless turned off,
    // once whenever the setup changes (opening, settings), so switching to
    // manual never leaves an empty Problems panel.
    const runOnce = mode !== "manual" || byHand || config.get<boolean>("checkOnStartup", true);
    for (const r of this.runners) {
      if (r instanceof ProjectRunner && !r.once) r.start();
      else if (runOnce) r.start();
    }
    if (mode === "manual" && !runOnce) this.log('Checking by hand: run "Project Problems: Recheck All Projects" to check.');
    this.setStatus();
  }

  private addProject(tsconfig: string, roots: string[], mode: Mode, toolFolders: Set<string>): void {
    const dir = path.dirname(tsconfig);
    const checker = findChecker(dir, roots);
    const rel = vscode.workspace.asRelativePath(tsconfig);
    if (!checker) {
      this.log(`${rel}: no TypeScript installed inside this workspace for this project. Install it (npm i -D typescript) to check it.`);
      return;
    }
    if (checker.kind === "svelte" || checker.kind === "astro") {
      const key = process.platform === "win32" ? dir.toLowerCase() : dir;
      if (toolFolders.has(key)) return;
      toolFolders.add(key);
      this.addTool(checker, dir);
      return;
    }
    this.log(`${rel}: checking with the project's ${checker.kind === "vue" ? "vue-tsc" : "TypeScript"} ${checker.version}${mode === "watch" ? "" : mode === "onSave" ? ", on save" : ", by hand"}.`);
    let restarts = 0;
    const cacheDir = this.cacheDir;
    const runner: ProjectRunner = new ProjectRunner(
      tsconfig,
      checker,
      cacheDir,
      {
        onStart: () => this.markChecking(tsconfig, true),
        onProblems: (problems) => {
          this.markChecking(tsconfig, false);
          this.byRunner.set(tsconfig, this.toDiagnostics(dir, problems, "", tsconfig));
          this.publish();
        },
        onLog: (line) => this.log(`${rel}: ${line}`),
        onExit: (code) => {
          this.markChecking(tsconfig, false);
          if (++restarts > MAX_RESTARTS) {
            this.log(`${rel}: the compiler stopped (exit ${code}) ${MAX_RESTARTS} times, so this project is no longer checked. Run "Project Problems: Recheck All Projects" after fixing it.`);
            return;
          }
          this.log(`${rel}: the compiler stopped (exit ${code}). Restarting in ${RESTART_AFTER_CRASH_MS / 1000} s.`);
          setTimeout(() => {
            if (this.runners.includes(runner)) runner.start();
          }, RESTART_AFTER_CRASH_MS);
        },
      },
      mode !== "watch",
    );
    this.runners.push(runner);
  }

  // svelte-check or astro check for one project folder.
  private addTool(checker: Checker, dir: string): void {
    const rel = vscode.workspace.asRelativePath(dir) || ".";
    const name = checker.kind === "svelte" ? "svelte-check" : "astro check";
    this.log(`${rel}: checking with the project's ${name} ${checker.version}, on save.`);
    const key = `${checker.kind}:${dir}`;
    const args = checker.kind === "svelte"
      ? ["--output", "machine", "--workspace", dir]
      // astro check updates the project's .astro folder, as astro dev does.
      : ["check"];
    const parse = checker.kind === "svelte" ? parseSvelteCheck : parseAstroCheck;
    const env: Record<string, string> = checker.kind === "astro" ? { ASTRO_TELEMETRY_DISABLED: "1", CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" } : {};
    const runner = new ToolRunner(key, checker.script, args, dir, parse, {
      onStart: () => this.markChecking(key, true),
      onProblems: (problems) => {
        this.markChecking(key, false);
        this.byRunner.set(key, this.toDiagnostics(dir, problems));
        this.publish();
      },
      onLog: (line) => this.log(`${rel}: ${line}`),
    }, env);
    this.runners.push(runner);
  }

  // ESLint over a whole workspace folder, with the project's own ESLint and config.
  private addEslint(root: string, roots: string[]): void {
    const eslint = findEslint(root, roots);
    const rel = vscode.workspace.asRelativePath(root) || path.basename(root);
    if (!eslint) {
      this.log(`${rel}: ESLint is on, but this folder has no ESLint installed with its own config, so it is not linted.`);
      return;
    }
    this.log(`${rel}: linting with the project's ESLint ${eslint.version}, on save.`);
    const key = `eslint:${root}`;
    this.eslintKeys.add(key);
    // ESLint's cache goes in the extension's storage, not the project.
    const cache = cacheFileFor(this.cacheDir, key, ".eslintcache");
    const paths = vscode.workspace.getConfiguration("projectProblems").get<string[]>("eslint.paths", ["."]);
    const args = ["--format", "json", "--cache", "--cache-location", cache, ...(paths.length ? paths : ["."])];
    const runner = new ToolRunner(key, eslint.script, args, root, parseEslintJson, {
      onStart: () => this.markChecking(key, true),
      onProblems: (problems) => {
        this.markChecking(key, false);
        this.byRunner.set(key, this.toDiagnostics(root, problems, "ESLint"));
        this.publish();
      },
      onLog: (line) => this.log(`${rel} ESLint: ${line}`),
    });
    this.runners.push(runner);
  }

  private get cacheDir(): string {
    return path.join(this.context.globalStorageUri.fsPath, "cache");
  }

  private onSave(doc: vscode.TextDocument): void {
    if (this.mode === "manual" || this.paused || !CHECKED.test(doc.uri.fsPath)) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      for (const r of this.runners) {
        // Watch-mode compilers notice the save themselves.
        if (r instanceof ProjectRunner && !r.once) continue;
        r.start();
      }
      this.setStatus();
    }, SAVE_DELAY_MS);
  }

  private markChecking(key: string, on: boolean): void {
    if (on) this.checking.add(key);
    else this.checking.delete(key);
    this.setStatus();
  }

  // pin: the file a problem with no location is shown on (the project's config).
  private toDiagnostics(dir: string, problems: TscProblem[], label = "", pin = path.join(dir, "tsconfig.json")): Map<string, vscode.Diagnostic[]> {
    const map = new Map<string, vscode.Diagnostic[]>();
    for (const p of problems) {
      // Errors about the project itself are pinned to its tsconfig.json.
      const file = p.file ? path.resolve(dir, p.file) : pin;
      const line = Math.max(0, p.line - 1);
      const col = Math.max(0, p.column - 1);
      const d = new vscode.Diagnostic(
        new vscode.Range(line, col, line, col + 1),
        p.message,
        p.severity === "error" ? vscode.DiagnosticSeverity.Error : p.severity === "warning" ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Information,
      );
      d.source = label ? `${SOURCE} (${label})` : SOURCE;
      d.code = p.code;
      const key = vscode.Uri.file(file).toString();
      const list = map.get(key) ?? [];
      list.push(d);
      map.set(key, list);
    }
    return map;
  }

  // Merges every runner's problems, drops duplicates (one file can belong to
  // several tsconfigs) and leaves open files to the editor's own checking.
  private publish(): void {
    const open = openFileUris();
    const eslintCovers = vscode.extensions.getExtension("dbaeumer.vscode-eslint") !== undefined;
    const merged = new Map<string, Map<string, vscode.Diagnostic>>();
    for (const [key, project] of this.byRunner) {
      const isEslint = this.eslintKeys.has(key);
      for (const [uri, diags] of project) {
        if (open.has(uri) && (isEslint ? eslintCovers : coveredWhenOpen(uri))) continue;
        const bucket = merged.get(uri) ?? new Map<string, vscode.Diagnostic>();
        for (const d of diags) bucket.set(`${d.source}:${d.range.start.line}:${d.range.start.character}:${d.code}:${d.message}`, d);
        merged.set(uri, bucket);
      }
    }
    this.collection.clear();
    for (const [uri, bucket] of merged) this.collection.set(vscode.Uri.parse(uri), [...bucket.values()]);
    this.setStatus();
  }

  private setStatus(): void {
    const enabled = vscode.workspace.getConfiguration("projectProblems").get<boolean>("enable", true);
    if (!enabled || this.paused) {
      this.status.text = "$(debug-pause) Project Problems";
      this.status.tooltip = "Paused. Run \"Project Problems: Pause or Resume\" to start again.";
    } else if (this.runners.length === 0) {
      this.status.text = "$(circle-slash) Project Problems";
      this.status.tooltip = "Nothing to check. See the output for why.";
    } else if (this.checking.size > 0) {
      this.status.text = "$(sync~spin) Checking project";
      this.status.tooltip = `Checking ${this.checking.size} of ${this.runners.length}.`;
    } else {
      let errors = 0;
      let warnings = 0;
      for (const [, diags] of this.collection) {
        for (const d of diags) {
          if (d.severity === vscode.DiagnosticSeverity.Error) errors++;
          else if (d.severity === vscode.DiagnosticSeverity.Warning) warnings++;
        }
      }
      this.status.text = `$(error) ${errors} $(warning) ${warnings} in project`;
      this.status.tooltip = this.mode === "manual"
        ? "Checked by hand. Run \"Project Problems: Recheck All Projects\" to check again. Click for details."
        : `${this.runners.length} checked. Click for details.`;
    }
    this.status.show();
  }

  private toggle(): void {
    this.paused = !this.paused;
    this.log(this.paused ? "Paused." : "Resumed.");
    void this.start();
  }

  // Removes the results; the next check brings back what is still there. A
  // one-off check still running would put its results straight back, so it is
  // stopped and runs again on the next save or recheck. Watch-mode compilers
  // keep going and report on the next change.
  private clear(): void {
    for (const r of this.runners) {
      if (r.running && (r instanceof ToolRunner || r.once)) {
        r.stop();
        this.checking.delete(r instanceof ToolRunner ? r.key : r.tsconfig);
      }
    }
    this.byRunner.clear();
    this.collection.clear();
    this.log("Cleared. The next check shows what is still there.");
    this.setStatus();
  }

  private scheduleRestart(): void {
    clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => void this.start(), 1000);
  }

  private stopAll(): void {
    for (const r of this.runners) r.stop();
    this.runners = [];
    this.byRunner.clear();
    this.eslintKeys.clear();
    this.checking.clear();
    this.collection.clear();
  }

  private log(line: string): void {
    this.output.appendLine(`[${new Date().toLocaleTimeString()}] ${line}`);
  }

  dispose(): void {
    clearTimeout(this.restartTimer);
    clearTimeout(this.saveTimer);
    this.stopAll();
    for (const d of this.disposables) d.dispose();
  }
}

function coveredWhenOpen(uri: string): boolean {
  const rule = COVERED_WHEN_OPEN.find((r) => r.test.test(uri));
  if (!rule) return false;
  return rule.extensions.length === 0 || rule.extensions.some((id) => vscode.extensions.getExtension(id) !== undefined);
}

// Referenced configs are found by following links, not by findFiles, so the
// exclude globs are checked again here.
function isExcluded(file: string, globs: string[]): boolean {
  const rel = vscode.workspace.asRelativePath(file, false).split(path.sep).join("/");
  return globs.some((g) => globToRegExp(g).test(rel));
}

function openFileUris(): Set<string> {
  const uris = new Set<string>();
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input;
      if (input instanceof vscode.TabInputText) uris.add(input.uri.toString());
      else if (input instanceof vscode.TabInputTextDiff) uris.add(input.modified.toString());
    }
  }
  return uris;
}
