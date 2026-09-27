import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { globToRegExp, parseJsonc, projectConfigs, isSolutionConfig } from "../src/tsconfig";

const fixture = path.resolve("test/fixtures/monorepo");

test("tsconfig comments and trailing commas parse", () => {
  assert.deepEqual(parseJsonc('{\n // c\n "a": [1, 2,], /* b */ "s": "// not a comment",\n}'), { a: [1, 2], s: "// not a comment" });
});

test("a link-only root config is a solution; a package config is not", () => {
  assert.equal(isSolutionConfig(path.join(fixture, "tsconfig.json")), true);
  assert.equal(isSolutionConfig(path.join(fixture, "packages/app/tsconfig.json")), false);
});

test("references are followed to every project, including odd names", () => {
  const found = projectConfigs([path.join(fixture, "tsconfig.json")], [fixture]).map((p) => path.relative(fixture, p).split(path.sep).join("/"));
  assert.deepEqual(found.sort(), ["packages/app/tsconfig.json", "packages/core/tsconfig.json", "tools/tsconfig.scripts.json"]);
});

test("a project found twice is only checked once", () => {
  const cfg = path.join(fixture, "packages/core/tsconfig.json");
  assert.equal(projectConfigs([cfg, path.join(fixture, "tsconfig.json"), cfg], [fixture]).length, 3);
});

test("exclude globs", () => {
  const nm = globToRegExp("**/node_modules/**");
  assert.ok(nm.test("node_modules/x/tsconfig.json"));
  assert.ok(nm.test("packages/a/node_modules/x/tsconfig.json"));
  assert.ok(!nm.test("packages/my_node_modules_fan/tsconfig.json"));
  assert.ok(globToRegExp("**/dist/**").test("dist/tsconfig.json"));
  assert.ok(!globToRegExp("**/dist/**").test("distance/tsconfig.json"));
  assert.ok(globToRegExp("tools/*.json").test("tools/tsconfig.scripts.json"));
  assert.ok(!globToRegExp("tools/*.json").test("tools/deep/tsconfig.json"));
});
