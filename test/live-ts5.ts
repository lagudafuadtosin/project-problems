import * as path from "node:path";
import * as os from "node:os";
import { ProjectRunner } from "../src/runner";
import { findCompiler } from "../src/tsconfig";
const root = path.resolve(".");
const dir = path.resolve("test/fixtures/ts5");
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const compiler = findCompiler(dir, [root])!;
const r = new ProjectRunner(path.join(dir, "tsconfig.json"), compiler, path.join(os.tmpdir(), "pp-test-cache"), {
  onStart() {}, onLog: (l) => console.log("log", l), onExit: (c) => console.log("exit", c),
  onProblems(ps) {
    const pid = (r as unknown as { child: { pid: number } }).child.pid;
    console.log(`TypeScript ${compiler.version} found: ${ps.map((p) => `${p.file}(${p.line}) ${p.code}`).join(" | ")} | compiler pid ${pid} alive: ${alive(pid)}`);
    r.stop();
    setTimeout(() => console.log(`after stop, pid ${pid} alive: ${alive(pid)}`), 3000);
  },
});
r.start();
