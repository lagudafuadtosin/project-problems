import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { isInside, projectConfigs, findCompiler } from "../src/tsconfig";
import { WatchParser, TscProblem } from "../src/parse";

const edge = path.resolve("test/fixtures/edge");

test("isInside does not treat a sibling with a longer name as inside", () => {
  const root = path.resolve("/work/proj");
  assert.ok(isInside(path.join(root, "a/tsconfig.json"), [root]));
  assert.ok(isInside(root, [root]));
  assert.ok(!isInside(path.resolve("/work/project2/tsconfig.json"), [root]));
  assert.ok(!isInside(path.resolve("/work/tsconfig.json"), [root]));
});

test("a reference that leaves the trusted folder is not followed", () => {
  const inner = path.join(edge, "inner");
  const found = projectConfigs([path.join(inner, "tsconfig.json")], [inner]);
  assert.deepEqual(found.map((f) => path.relative(inner, f)), ["tsconfig.json"]);
});

test("references that loop are each checked once and the walk ends", () => {
  const found = projectConfigs([path.join(edge, "cycle-a/tsconfig.json")], [edge]).map((f) => path.basename(path.dirname(f)));
  assert.deepEqual(found.sort(), ["cycle-a", "cycle-b"]);
});

test("configs given from outside the trusted folders are dropped", () => {
  assert.deepEqual(projectConfigs([path.join(edge, "cycle-a/tsconfig.json")], [path.join(edge, "inner")]), []);
});

test("a TypeScript install outside the trusted folders is not used", () => {
  // TypeScript is installed in edge/node_modules, above the inner folder.
  const inner = path.join(edge, "inner");
  assert.equal(findCompiler(inner, [inner]), null);
  assert.ok(findCompiler(inner, [edge]));
});

test("output with no line breaks cannot grow memory without limit", () => {
  const runs: TscProblem[][] = [];
  const p = new WatchParser((r) => runs.push(r));
  for (let i = 0; i < 30; i++) p.push("x".repeat(100_000)); // 3 MB, no newline
  p.push("\n08:00:00 PM - Starting compilation in watch mode...\na.ts(1,1): error TS1005: ';' expected.\n08:00:00 PM - Found 1 error. Watching for file changes.\n");
  assert.equal(runs.length, 1);
  assert.equal(runs[0][0].file, "a.ts");
  assert.ok((p as unknown as { buffer: string }).buffer.length < 1_000_001);
});

test("hostile text in compiler output stays plain data", () => {
  const runs: TscProblem[][] = [];
  const p = new WatchParser((r) => runs.push(r));
  p.push(
    "08:00:00 PM - Starting compilation in watch mode...\n" +
      "../../../etc/passwd(1,1): error TS2322: <img src=x onerror=alert(1)> $(rm -rf /) \u001b]0;title\u0007\n" +
      "08:00:00 PM - Found 1 error. Watching for file changes.\n",
  );
  const [e] = runs[0];
  assert.equal(e.file, "../../../etc/passwd");
  assert.ok(e.message.includes("<img src=x onerror=alert(1)>"));
});
