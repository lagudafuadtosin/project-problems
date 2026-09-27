import * as vscode from "vscode";
import * as path from "node:path";
import { TscProblem } from "./parse";
import { ProjectRunner } from "./runner";
import { findCompiler, globToRegExp, projectConfigs } from "./tsconfig";

// Project Problems: runs each tsconfig project's own compiler in watch mode and
// puts every error in the Problems panel, including files that are not open.
// Files that are open are left to VS Code's TypeScript support, which already
// reports them live, so nothing is listed twice.

const SOURCE = "Project Problems";
const RESTART_AFTER_CRASH_MS = 5000;
const MAX_RESTARTS = 3;

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
  private runners: ProjectRunner[] = [];
  // Latest problems per project, keyed by file URI.
  private readonly byProject = new Map<string, Map<string, vscode.Diagnostic[]>>();
  private readonly checking = new Set<string>();
  private paused = false;
  private restartTimer: NodeJS.Timeout | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.status.command = "projectProblems.showOutput";
    this.disposables.push(
      this.collection,
      this.output,
      this.status,
      vscode.commands.registerCommand("projectProblems.recheck", () => this.start()),
      vscode.commands.registerCommand("projectProblems.toggle", () => this.toggle()),
      vscode.commands.registerCommand("projectProblems.showOutput", () => this.output.show(true)),
      vscode.window.tabGroups.onDidChangeTabs(() => this.publish()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("projectProblems")) this.scheduleRestart();
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.scheduleRestart()),
      vscode.workspace.onDidGrantWorkspaceTrust(() => this.scheduleRestart()),
    );
    // A tsconfig added, removed or edited changes what there is to check.
    const watcher = vscode.workspace.createFileSystemWatcher("**/tsconfig*.json");
    watcher.onDidCreate(() => this.scheduleRestart());
    watcher.onDidDelete(() => this.scheduleRestart());
    watcher.onDidChange(() => this.scheduleRestart());
    this.disposables.push(watcher);
  }

  async start(): Promise<void> {
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
    if (configs.length === 0) {
      this.log("No tsconfig.json found in this workspace.");
      this.setStatus();
      return;
    }
    if (configs.length > max) {
      this.log(`${configs.length} projects found; checking the first ${max}. Raise projectProblems.maxProjects to check more.`);
    }
    for (const tsconfig of configs.slice(0, max)) this.startProject(tsconfig, roots);
    this.setStatus();
  }

  private startProject(tsconfig: string, roots: string[]): void {
    const compiler = findCompiler(path.dirname(tsconfig), roots);
    const rel = vscode.workspace.asRelativePath(tsconfig);
    if (!compiler) {
      this.log(`${rel}: no TypeScript installed inside this workspace for this project. Install it (npm i -D typescript) to check it.`);
      return;
    }
    this.log(`${rel}: checking with the project's TypeScript ${compiler.version}.`);
    let restarts = 0;
    const cacheDir = path.join(this.context.globalStorageUri.fsPath, "cache");
    const runner = new ProjectRunner(tsconfig, compiler, cacheDir, {
      onStart: () => {
        this.checking.add(tsconfig);
        this.setStatus();
      },
      onProblems: (problems) => {
        this.checking.delete(tsconfig);
        this.byProject.set(tsconfig, this.toDiagnostics(tsconfig, problems));
        this.publish();
      },
      onLog: (line) => this.log(`${rel}: ${line}`),
      onExit: (code) => {
        this.checking.delete(tsconfig);
        this.setStatus();
        if (++restarts > MAX_RESTARTS) {
          this.log(`${rel}: the compiler stopped (exit ${code}) ${MAX_RESTARTS} times, so this project is no longer checked. Run "Project Problems: Recheck All Projects" after fixing it.`);
          return;
        }
        this.log(`${rel}: the compiler stopped (exit ${code}). Restarting in ${RESTART_AFTER_CRASH_MS / 1000} s.`);
        setTimeout(() => {
          if (this.runners.includes(runner)) runner.start();
        }, RESTART_AFTER_CRASH_MS);
      },
    });
    this.runners.push(runner);
    this.checking.add(tsconfig);
    runner.start();
  }

  private toDiagnostics(tsconfig: string, problems: TscProblem[]): Map<string, vscode.Diagnostic[]> {
    const dir = path.dirname(tsconfig);
    const map = new Map<string, vscode.Diagnostic[]>();
    for (const p of problems) {
      // Errors about the project itself are pinned to its tsconfig.json.
      const file = p.file ? path.resolve(dir, p.file) : tsconfig;
      const line = Math.max(0, p.line - 1);
      const col = Math.max(0, p.column - 1);
      const d = new vscode.Diagnostic(
        new vscode.Range(line, col, line, col + 1),
        p.message,
        p.severity === "error" ? vscode.DiagnosticSeverity.Error : p.severity === "warning" ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Information,
      );
      d.source = SOURCE;
      d.code = p.code;
      const key = vscode.Uri.file(file).toString();
      const list = map.get(key) ?? [];
      list.push(d);
      map.set(key, list);
    }
    return map;
  }

  // Merges every project's problems, drops duplicates (one file can belong to
  // several tsconfigs) and hides files that are open in the editor.
  private publish(): void {
    const open = openFileUris();
    const merged = new Map<string, Map<string, vscode.Diagnostic>>();
    for (const project of this.byProject.values()) {
      for (const [uri, diags] of project) {
        if (open.has(uri)) continue;
        const bucket = merged.get(uri) ?? new Map<string, vscode.Diagnostic>();
        for (const d of diags) bucket.set(`${d.range.start.line}:${d.range.start.character}:${d.code}:${d.message}`, d);
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
      this.status.tooltip = `Checking ${this.checking.size} of ${this.runners.length} project(s).`;
    } else {
      let errors = 0;
      let warnings = 0;
      for (const project of this.byProject.values()) {
        for (const diags of project.values()) {
          for (const d of diags) {
            if (d.severity === vscode.DiagnosticSeverity.Error) errors++;
            else if (d.severity === vscode.DiagnosticSeverity.Warning) warnings++;
          }
        }
      }
      this.status.text = `$(error) ${errors} $(warning) ${warnings} in project`;
      this.status.tooltip = `${this.runners.length} project(s) checked. Click for details.`;
    }
    this.status.show();
  }

  private toggle(): void {
    this.paused = !this.paused;
    this.log(this.paused ? "Paused." : "Resumed.");
    void this.start();
  }

  private scheduleRestart(): void {
    clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => void this.start(), 1000);
  }

  private stopAll(): void {
    for (const r of this.runners) r.stop();
    this.runners = [];
    this.byProject.clear();
    this.checking.clear();
    this.collection.clear();
  }

  private log(line: string): void {
    this.output.appendLine(`[${new Date().toLocaleTimeString()}] ${line}`);
  }

  dispose(): void {
    clearTimeout(this.restartTimer);
    this.stopAll();
    for (const d of this.disposables) d.dispose();
  }
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
