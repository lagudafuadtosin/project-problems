// 1.0: svelte-check, astro check and ESLint output, one-off tsc runs, and
// finding the right checker for a project. The outputs are captured from the
// real tools on the fixtures (test/captured), colour codes and all.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { parseAstroCheck, parseEslintJson, parseSvelteCheck } from "../src/parse-tools";
import { WatchParser, TscProblem } from "../src/parse";
import { findChecker, findEslint, findBin } from "../src/tsconfig";

const captured = (f: string) => readFileSync(path.resolve("test/captured", f), "utf8");
const fixtures = path.resolve("test/fixtures");

test("svelte-check machine output: file, place and message, doubled backslashes undone", () => {
  const ps = parseSvelteCheck(captured("svelte-check.txt"));
  assert.equal(ps.length, 1);
  assert.deepEqual(ps[0], { file: "src\\App.svelte", line: 2, column: 7, severity: "error", code: "svelte-check", message: "Type 'string' is not assignable to type 'number'." });
});

test("svelte-check warnings and quotes inside the message", () => {
  const ps = parseSvelteCheck('1 WARNING "src/a.svelte" 3:1 "A11y: <img> needs an \\"alt\\""\n1 COMPLETED 1 FILES 0 ERRORS 1 WARNINGS 1 FILES_WITH_PROBLEMS\n');
  assert.deepEqual(ps.map((p) => [p.severity, p.message]), [["warning", 'A11y: <img> needs an "alt"']]);
});

test("astro check output, with its colour codes, becomes a TS problem and the code frame is skipped", () => {
  for (const f of ["astro-check.txt", "astro-check-nocolor.txt"]) {
    const ps = parseAstroCheck(captured(f));
    assert.equal(ps.length, 1, f);
    assert.deepEqual(ps[0], { file: "src/pages/index.astro", line: 2, column: 7, severity: "error", code: "TS2322", message: "Type 'string' is not assignable to type 'number'." });
  }
});

test("ESLint JSON: errors and warnings with their rule, files without messages skipped", () => {
  const ps = parseEslintJson(captured("eslint.json"));
  assert.deepEqual(ps.map((p) => [path.basename(p.file ?? ""), p.line, p.severity, p.code]), [
    ["never-opened.js", 1, "error", "no-unused-vars"],
    ["never-opened.js", 2, "warning", "no-console"],
  ]);
  assert.ok(path.isAbsolute(ps[0].file ?? ""));
});

test("ESLint output that is not JSON gives nothing rather than a crash", () => {
  assert.deepEqual(parseEslintJson("Oops! Something went wrong!"), []);
});

test("a one-off tsc run hands its problems over when the process ends", () => {
  const runs: TscProblem[][] = [];
  const p = new WatchParser((ps) => runs.push(ps));
  p.push("src/App.vue(2,7): error TS2322: Type 'string' is not assignable to type 'number'.\n");
  p.finish();
  assert.equal(runs.length, 1);
  assert.equal(runs[0][0].file, "src/App.vue");
});

test("a clean one-off run reports clean, and a run that already summed up is not wiped", () => {
  const runs: TscProblem[][] = [];
  const clean = new WatchParser((ps) => runs.push(ps));
  clean.finish();
  assert.deepEqual(runs, [[]]);

  const runs2: TscProblem[][] = [];
  const summed = new WatchParser((ps) => runs2.push(ps));
  summed.push("a.ts(1,1): error TS1: x\nFound 1 error.\n");
  summed.finish();
  assert.equal(runs2.length, 1);
  assert.equal(runs2[0].length, 1);
});

test("each project gets its own framework's checker", () => {
  const roots = [fixtures];
  assert.equal(findChecker(path.join(fixtures, "vue"), roots)?.kind, "vue");
  assert.equal(findChecker(path.join(fixtures, "svelte"), roots)?.kind, "svelte");
  assert.equal(findChecker(path.join(fixtures, "astro"), roots)?.kind, "astro");
  assert.equal(findChecker(path.join(fixtures, "eslint"), roots)?.kind, "tsc");
});

test("ESLint only where the project installs it and has its own config", () => {
  const roots = [fixtures];
  assert.ok(findEslint(path.join(fixtures, "eslint"), roots));
  assert.equal(findEslint(path.join(fixtures, "vue"), roots), null);
});

test("a checker installed outside the opened folders is never used", () => {
  // The vue fixture installs vue-tsc, but with only a sibling folder opened it must not be found.
  const outside = findBin(path.join(fixtures, "vue"), [path.join(fixtures, "svelte")], "vue-tsc", "vue-tsc");
  assert.equal(outside, null);
  assert.equal(findChecker(path.join(fixtures, "astro"), [path.join(fixtures, "vue")]), null);
});
