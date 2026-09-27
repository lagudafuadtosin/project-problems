// Live edge and security run with the real TypeScript 7 compiler, outside VS Code.
import * as path from "node:path";
import * as os from "node:os";
import { existsSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { ProjectRunner } from "../src/runner";
import { findCompiler, projectConfigs } from "../src/tsconfig";
import { TscProblem } from "../src/parse";

const edge = path.resolve("test/fixtures/edge");
const cache = path.join(os.tmpdir(), "pp-test-cache");
const names = ["sp ace é (1)", "a & mkdir PWNED1 & b", "$(mkdir PWNED2)", "broken-json", "no-inputs", "extends", "cycle-a", "cycle-b"];
const configs = projectConfigs(names.map((n) => path.join(edge, n, "tsconfig.json")), [edge]);
const compiler = findCompiler(edge, [edge])!;
const compilerCount = () => {
  const out = execFileSync("tasklist", ["/FI", "IMAGENAME eq tsc.exe", "/FO", "CSV", "/NH"], { encoding: "utf8" });
  return out.split("\n").filter((l) => l.includes("tsc.exe")).length;
};
const before = compilerCount();
console.log(`TypeScript ${compiler.version}; ${configs.length} projects; tsc.exe running before: ${before}`);

const spaced = path.join(edge, "sp ace é (1)");
const passes = new Map<string, number>();
const runners: ProjectRunner[] = [];
let finished = 0;
const show = (ps: TscProblem[]) => ps.map((p) => `${p.file ?? "(project)"}(${p.line}) ${p.code}`).join(" | ") || "clean";

for (const cfg of configs) {
  const name = path.basename(path.dirname(cfg));
  const r = new ProjectRunner(cfg, compiler, cache, {
    onStart() {},
    onLog: (l) => console.log(`  log [${name}]`, l),
    onExit: (c) => console.log(`  exit [${name}]`, c),
    onProblems(ps) {
      const n = (passes.get(cfg) ?? 0) + 1;
      passes.set(cfg, n);
      console.log(`[${name}] pass ${n}: ${show(ps)}`);
      if (cfg.startsWith(spaced)) {
        if (n === 1) writeFileSync(path.join(spaced, "src", "new.ts"), 'export const added: boolean = "new file";\n');
        else if (n === 2) rmSync(path.join(spaced, "src", "bad.ts"));
        else if (n === 3) done();
      } else if (n === 1) done();
    },
  });
  runners.push(r);
  r.start();
}

function done() {
  if (++finished < configs.length) return;
  for (const r of runners) r.stop();
  setTimeout(() => {
    console.log(`tsc.exe running after stop: ${compilerCount()} (before: ${before})`);
    const pwned = ["PWNED1", "PWNED2"].flatMap((p) => [edge, ...readdirSync(edge).map((d) => path.join(edge, d))].filter((d) => existsSync(path.join(d, p))));
    console.log(pwned.length ? `COMMAND RAN: ${pwned.join(", ")}` : "no injected command ran (no PWNED folders anywhere)");
    writeFileSync(path.join(spaced, "src", "bad.ts"), 'export const v: number = "sp ace é (1)";\n');
    rmSync(path.join(spaced, "src", "new.ts"), { force: true });
  }, 3000);
}
setTimeout(() => { for (const r of runners) r.stop(); console.log("timeout"); }, 90000).unref();
