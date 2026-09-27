import { test } from "node:test";
import assert from "node:assert/strict";
import { WatchParser, TscProblem } from "../src/parse";

function run(output: string): TscProblem[][] {
  const runs: TscProblem[][] = [];
  const p = new WatchParser((problems) => runs.push(problems));
  p.push(output);
  return runs;
}

test("TypeScript 7 watch output, with the screen clear and timestamps", () => {
  const out =
    "\u001b[2J\u001b[3J\u001b[H08:11:19 PM - Starting compilation in watch mode...\n\n" +
    "src/never-opened.ts(2,14): error TS2322: Type 'string' is not assignable to type 'number'.\n" +
    "08:11:19 PM - Found 1 error. Watching for file changes.\n";
  const [first] = run(out);
  assert.equal(first.length, 1);
  assert.deepEqual(first[0], {
    file: "src/never-opened.ts",
    line: 2,
    column: 14,
    severity: "error",
    code: "TS2322",
    message: "Type 'string' is not assignable to type 'number'.",
  });
});

test("TypeScript 5 style bracketed timestamps", () => {
  const out =
    "[3:14:15 PM] Starting compilation in watch mode...\n" +
    "a.ts(1,1): error TS1005: ';' expected.\n" +
    "[3:14:16 PM] Found 1 error. Watching for file changes.\n";
  assert.equal(run(out)[0][0].code, "TS1005");
});

test("each pass replaces the last, so fixed errors disappear", () => {
  const out =
    "08:00:00 PM - Starting compilation in watch mode...\n" +
    "a.ts(1,1): error TS1005: ';' expected.\n" +
    "08:00:00 PM - Found 1 error. Watching for file changes.\n" +
    "08:00:05 PM - File change detected. Starting incremental compilation...\n" +
    "08:00:05 PM - Found 0 errors. Watching for file changes.\n";
  const runs = run(out);
  assert.equal(runs.length, 2);
  assert.equal(runs[0].length, 1);
  assert.equal(runs[1].length, 0);
});

test("indented lines join the message above them", () => {
  const out =
    "08:00:00 PM - Starting compilation in watch mode...\n" +
    "src/a.ts(3,5): error TS2322: Type '{ a: string; }' is not assignable to type 'B'.\n" +
    "  Object literal may only specify known properties, and 'a' does not exist in type 'B'.\n" +
    "08:00:00 PM - Found 1 error. Watching for file changes.\n";
  assert.equal(
    run(out)[0][0].message,
    "Type '{ a: string; }' is not assignable to type 'B'.\nObject literal may only specify known properties, and 'a' does not exist in type 'B'.",
  );
});

test("project-level errors with no file are kept", () => {
  const out =
    "08:00:00 PM - Starting compilation in watch mode...\n" +
    "error TS5083: Cannot read file 'tsconfig.base.json'.\n" +
    "08:00:00 PM - Found 1 error. Watching for file changes.\n";
  const [p] = run(out)[0];
  assert.equal(p.file, null);
  assert.equal(p.code, "TS5083");
});

test("Windows line endings and paths with brackets and spaces", () => {
  const out =
    "08:00:00 PM - Starting compilation in watch mode...\r\n" +
    "src/My Folder/file (copy).ts(10,2): error TS2304: Cannot find name 'x'.\r\n" +
    "08:00:00 PM - Found 1 error. Watching for file changes.\r\n";
  const [p] = run(out)[0];
  assert.equal(p.file, "src/My Folder/file (copy).ts");
  assert.equal(p.line, 10);
});

test("output split across chunks at awkward places", () => {
  const runs: TscProblem[][] = [];
  const p = new WatchParser((problems) => runs.push(problems));
  const out = "08:00:00 PM - Starting compilation in watch mode...\na.ts(1,1): error TS1005: ';' expected.\n08:00:00 PM - Found 1 error. Watching for file changes.\n";
  for (let i = 0; i < out.length; i += 7) p.push(out.slice(i, i + 7));
  assert.equal(runs.length, 1);
  assert.equal(runs[0][0].file, "a.ts");
});

test("warnings and messages keep their severity", () => {
  const out =
    "08:00:00 PM - Starting compilation in watch mode...\n" +
    "a.ts(1,1): warning TS6133: 'x' is declared but its value is never read.\n" +
    "08:00:00 PM - Found 0 errors. Watching for file changes.\n";
  assert.equal(run(out)[0][0].severity, "warning");
});
