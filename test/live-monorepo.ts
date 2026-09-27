// Runs discovery and the real compiler on the monorepo fixture, outside VS Code.
import * as path from "node:path";
import { ProjectRunner } from "../src/runner";
import { findCompiler, projectConfigs } from "../src/tsconfig";
import { TscProblem } from "../src/parse";

const root = path.resolve("test/fixtures/monorepo");
const configs = projectConfigs([path.join(root, "tsconfig.json")], [root]);
console.log("projects:", configs.map((c) => path.relative(root, c)).join(", "));
const t0 = Date.now();
const results = new Map<string, TscProblem[]>();
const runners: ProjectRunner[] = [];
for (const cfg of configs) {
  const compiler = findCompiler(path.dirname(cfg), [root])!;
  const r = new ProjectRunner(cfg, compiler, require("node:os").tmpdir() + "/pp-test-cache", {
    onStart() {},
    onLog: (l) => console.log("log", path.relative(root, cfg), l),
    onExit: (c) => console.log("exit", c),
    onProblems(ps) {
      results.set(cfg, ps);
      console.log(`${path.relative(root, cfg)} done in ${Date.now() - t0} ms:`, ps.map((p) => `${p.file}(${p.line}) ${p.code}`).join(" | ") || "clean");
      if (results.size === configs.length) {
        const unique = new Set<string>();
        let raw = 0;
        for (const [c, list] of results) for (const p of list) {
          raw++;
          unique.add(`${path.resolve(path.dirname(c), p.file ?? "")}:${p.line}:${p.column}:${p.code}`);
        }
        console.log(`raw ${raw}, unique after merging ${unique.size}`);
        for (const x of runners) x.stop();
      }
    },
  });
  runners.push(r);
  r.start();
}
setTimeout(() => { for (const x of runners) x.stop(); console.log("timeout"); }, 60000).unref();
