// Runs the real checkers on the framework fixtures through the extension's own
// runners, outside VS Code: vue-tsc (one-off and watch), svelte-check, astro
// check and ESLint. Checks the problems found, a save during a run, stopping
// mid-run, the ESLint cache location, and that nothing is left running.
import * as path from "node:path";
import * as os from "node:os";
import { existsSync, readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { ProjectRunner, ToolRunner } from "../src/runner";
import { findChecker, findEslint } from "../src/tsconfig";
import { parseAstroCheck, parseEslintJson, parseSvelteCheck } from "../src/parse-tools";
import { TscProblem } from "../src/parse";

const fx = path.resolve("test/fixtures");
const roots = [fx];
const cacheDir = path.join(os.tmpdir(), "pp-frameworks-cache");
rmSync(cacheDir, { recursive: true, force: true });
let failed = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed++;
};
const show = (ps: TscProblem[]) => ps.map((p) => `${(p.file ?? "").split(/[\\/]/).pop()}(${p.line}) ${p.code}`).join(" | ") || "clean";
const quiet = { onStart() {}, onLog() {} };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function once(r: { start(): void }, collect: TscProblem[][]): Promise<TscProblem[]> {
  return new Promise((resolve) => {
    const n = collect.length;
    const t = setInterval(() => {
      if (collect.length > n) {
        clearInterval(t);
        resolve(collect[collect.length - 1]);
      }
    }, 50);
    r.start();
  });
}

function countNode(pattern: string): number {
  if (process.platform !== "win32") return 0;
  const out = execFileSync("powershell", ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*${pattern}*' }).Count`], { encoding: "utf8" });
  return Number(out.trim() || 0);
}

async function main() {
  // vue-tsc, one-off
  const vueDir = path.join(fx, "vue");
  const vue = findChecker(vueDir, roots)!;
  check(vue.kind === "vue", `vue project uses vue-tsc ${vue.version}`);
  const vueRuns: TscProblem[][] = [];
  const vueOnce = new ProjectRunner(path.join(vueDir, "tsconfig.json"), vue, cacheDir, { ...quiet, onExit() {}, onProblems: (p) => vueRuns.push(p) }, true);
  let ps = await once(vueOnce, vueRuns);
  console.log("     vue once:", show(ps));
  check(ps.length === 1 && ps[0].file === "src/App.vue" && ps[0].line === 2 && ps[0].code === "TS2322", "vue-tsc one-off finds the error inside the .vue file");

  // vue-tsc, watch: fix the file, the error goes; put it back, it returns
  const appVue = path.join(vueDir, "src", "App.vue");
  const original = readFileSync(appVue, "utf8");
  const watchRuns: TscProblem[][] = [];
  const vueWatch = new ProjectRunner(path.join(vueDir, "tsconfig.json"), vue, cacheDir, { ...quiet, onExit: (c) => console.log("     watch exit", c), onProblems: (p) => watchRuns.push(p) }, false);
  ps = await once(vueWatch, watchRuns);
  check(ps.length === 1, "vue-tsc watch: error on the first pass");
  const before = watchRuns.length;
  writeFileSync(appVue, original.replace('"not a number"', "42"));
  for (let i = 0; i < 200 && watchRuns.length === before; i++) await wait(100);
  check(watchRuns.length > before && watchRuns[watchRuns.length - 1].length === 0, "vue-tsc watch: fixing the file clears it");
  const before2 = watchRuns.length;
  writeFileSync(appVue, original);
  for (let i = 0; i < 200 && watchRuns.length === before2; i++) await wait(100);
  check(watchRuns.length > before2 && watchRuns[watchRuns.length - 1].length === 1, "vue-tsc watch: breaking it again brings it back");
  vueWatch.stop();
  await wait(1500);
  check(countNode("vue-tsc") === 0, "no vue-tsc process left after stop");

  // svelte-check
  const svDir = path.join(fx, "svelte");
  const sv = findChecker(svDir, roots)!;
  check(sv.kind === "svelte", `svelte project uses svelte-check ${sv.version}`);
  const svRuns: TscProblem[][] = [];
  const svRunner = new ToolRunner("svelte", sv.script, ["--output", "machine", "--workspace", svDir], svDir, parseSvelteCheck, { ...quiet, onProblems: (p) => svRuns.push(p) });
  ps = await once(svRunner, svRuns);
  console.log("     svelte:", show(ps));
  check(ps.length === 1 && /App\.svelte$/.test(ps[0].file ?? "") && ps[0].line === 2, "svelte-check finds the error in App.svelte");
  // A save while a check is running waits and runs once more.
  const n = svRuns.length;
  svRunner.start();
  svRunner.start();
  for (let i = 0; i < 300 && svRuns.length < n + 2; i++) await wait(100);
  await wait(1500);
  check(svRuns.length === n + 2, `two starts during one run give exactly two results (got ${svRuns.length - n})`);

  // astro check
  const asDir = path.join(fx, "astro");
  const as = findChecker(asDir, roots)!;
  check(as.kind === "astro", `astro project uses astro check (astro ${as.version})`);
  const asRuns: TscProblem[][] = [];
  const env = { ASTRO_TELEMETRY_DISABLED: "1", CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" };
  const asRunner = new ToolRunner("astro", as.script, ["check"], asDir, parseAstroCheck, { ...quiet, onProblems: (p) => asRuns.push(p) }, env);
  ps = await once(asRunner, asRuns);
  console.log("     astro:", show(ps));
  check(ps.length === 1 && ps[0].file === "src/pages/index.astro" && ps[0].code === "TS2322", "astro check finds the error in index.astro");
  // Stopping mid-run reports nothing afterwards and leaves nothing running.
  const m = asRuns.length;
  asRunner.start();
  await wait(300);
  asRunner.stop();
  await wait(4000);
  check(asRuns.length === m, "stopping astro check mid-run reports nothing after the stop");
  check(countNode("astro.js") === 0, "no astro process left after stop");

  // ESLint, with its cache in the extension's storage
  const esDir = path.join(fx, "eslint");
  const es = findEslint(esDir, roots)!;
  check(Boolean(es), `eslint project found with ESLint ${es?.version}`);
  const cache = path.join(cacheDir, "eslint-test.eslintcache");
  const esRuns: TscProblem[][] = [];
  const esRunner = new ToolRunner("eslint", es.script, ["--format", "json", "--cache", "--cache-location", cache, "."], esDir, parseEslintJson, { ...quiet, onProblems: (p) => esRuns.push(p) });
  ps = await once(esRunner, esRuns);
  console.log("     eslint:", show(ps));
  check(ps.length === 2 && ps.some((p) => p.code === "no-unused-vars" && p.severity === "error") && ps.some((p) => p.code === "no-console" && p.severity === "warning"), "ESLint finds the error and the warning in the never-opened file");
  check(existsSync(cache), "ESLint cache written to the extension's storage");
  check(!readdirSync(esDir).some((f) => f.startsWith(".eslintcache")), "no .eslintcache written into the project");
  ps = await once(esRunner, esRuns);
  check(ps.length === 2, "a second ESLint run with the cache gives the same results");

  // Nothing changed in any fixture (the watch test put App.vue back).
  check(readFileSync(appVue, "utf8") === original, "App.vue is back as it was");

  console.log(failed ? `\n${failed} FAILED` : "\nall good");
  process.exit(failed ? 1 : 0);
}

void main();
