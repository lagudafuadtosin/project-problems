// Runs inside a real VS Code (see run.ts): the whole extension, not just its
// parts. Every check reads the Problems panel through the VS Code API.
import * as vscode from "vscode";
import * as path from "node:path";
import { readFileSync, writeFileSync } from "node:fs";

const fixtures = path.resolve(__dirname, "..", "test", "fixtures");
const file = (...p: string[]) => vscode.Uri.file(path.join(fixtures, ...p));
const ours = (uri: vscode.Uri) => vscode.languages.getDiagnostics(uri).filter((d) => String(d.source).startsWith("Project Problems"));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(what: string, ok: () => boolean, ms = 90000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (ok()) return true;
    await wait(250);
  }
  console.log(`  (timed out waiting for: ${what})`);
  return false;
}

async function setting(key: string, value: unknown): Promise<void> {
  await vscode.workspace.getConfiguration("projectProblems").update(key, value, vscode.ConfigurationTarget.Workspace);
}

// Saves a file through VS Code, the way a coach's editor would, without
// opening it in a tab (a tab would hand it to the editor's own checking).
async function saveAs(uri: vscode.Uri, text: string): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(uri);
  const edit = new vscode.WorkspaceEdit();
  edit.replace(uri, new vscode.Range(0, 0, doc.lineCount, 0), text);
  await vscode.workspace.applyEdit(edit);
  await doc.save();
}

export async function run(): Promise<void> {
  let failed = 0;
  const check = (ok: boolean, what: string) => {
    console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
    if (!ok) failed++;
  };
  const appVue = file("vue", "src", "App.vue");
  const appSvelte = file("svelte", "src", "App.svelte");
  const indexAstro = file("astro", "src", "pages", "index.astro");
  const lintMe = file("eslint", "src", "never-opened.js");
  const vueText = readFileSync(appVue.fsPath, "utf8");

  try {
    await vscode.extensions.getExtension("lagudafuadtosin.project-problems")!.activate();

    // Watch mode: every framework's error, in files never opened.
    check(await until("vue", () => ours(appVue).some((d) => d.code === "TS2322")), "watch: Vue error in a .vue file that is not open");
    check(await until("svelte", () => ours(appSvelte).length === 1), "watch: Svelte error in a .svelte file that is not open");
    check(await until("astro", () => ours(indexAstro).some((d) => d.code === "TS2322")), "watch: Astro error in an .astro file that is not open");
    check(ours(lintMe).length === 0, "ESLint off by default: nothing from it");

    // Watch mode notices a save in the Vue project by itself.
    await saveAs(appVue, vueText.replace('"not a number"', "42"));
    check(await until("vue cleared", () => ours(appVue).length === 0), "watch: fixing App.vue clears its error");
    await saveAs(appVue, vueText);
    check(await until("vue back", () => ours(appVue).length === 1), "watch: breaking it again brings the error back");

    // ESLint on.
    await setting("eslint.enable", true);
    check(await until("eslint", () => ours(lintMe).length === 2), "ESLint on: the error and the warning in the never-opened file");
    const sources = new Set(ours(lintMe).map((d) => d.source));
    check(sources.has("Project Problems (ESLint)"), "ESLint problems are labelled as ESLint");

    // On save: a fix shows up only after saving, and the svelte check reruns on save.
    await setting("mode", "onSave");
    await wait(2500);
    check(await until("onSave first check", () => ours(appVue).length === 1 && ours(appSvelte).length === 1), "onSave: checks once when switched on");
    await saveAs(appVue, vueText.replace('"not a number"', "42"));
    check(await until("onSave vue cleared", () => ours(appVue).length === 0), "onSave: saving the fix clears it");
    await saveAs(appVue, vueText);
    check(await until("onSave vue back", () => ours(appVue).length === 1), "onSave: saving the break brings it back");

    // Manual: a save changes nothing until Recheck.
    await setting("mode", "manual");
    await wait(2500); // the settings change restarts the checks after a second
    check(await until("manual first check", () => ours(appVue).length === 1), "manual: checks once when switched on (check on startup)");
    await saveAs(appVue, vueText.replace('"not a number"', "42"));
    await wait(6000);
    check(ours(appVue).length === 1, "manual: a save does not recheck");
    await vscode.commands.executeCommand("projectProblems.recheck");
    check(await until("manual recheck", () => ours(appVue).length === 0), "manual: Recheck picks up the fix");

    // Clear.
    await vscode.commands.executeCommand("projectProblems.clear");
    await wait(500);
    check([appVue, appSvelte, indexAstro, lintMe].every((u) => ours(u).length === 0), "Clear removes every result");
  } finally {
    writeFileSync(appVue.fsPath, vueText);
    await setting("mode", undefined);
    await setting("eslint.enable", undefined);
  }

  console.log(failed ? `\n${failed} FAILED` : "\nall good");
  if (failed) throw new Error(`${failed} host checks failed`);
}
