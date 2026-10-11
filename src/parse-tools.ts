// Output readers for the checkers that are not plain tsc: svelte-check,
// astro check and ESLint. Kept free of the VS Code API so they can be tested
// with Node, like parse.ts.

import { TscProblem, Severity, cleanLine } from "./parse";

// svelte-check --output machine:
//   1791746205921 ERROR "src\\App.svelte" 2:7 "Type 'string' is not assignable to type 'number'."
// The path is relative to --workspace and JSON-quoted, so backslashes come doubled.
const SVELTE = /^\d+\s+(ERROR|WARNING)\s+("(?:[^"\\]|\\.)*")\s+(\d+):(\d+)\s+("(?:[^"\\]|\\.)*")\s*$/;

export function parseSvelteCheck(output: string): TscProblem[] {
  const out: TscProblem[] = [];
  for (const raw of output.split("\n")) {
    const m = cleanLine(raw).match(SVELTE);
    if (!m) continue;
    let file: string;
    let message: string;
    try {
      file = JSON.parse(m[2]) as string;
      message = JSON.parse(m[5]) as string;
    } catch {
      continue;
    }
    out.push({
      file,
      line: Number(m[3]),
      column: Number(m[4]),
      severity: m[1] === "ERROR" ? "error" : "warning",
      code: "svelte-check",
      message,
    });
  }
  return out;
}

// astro check prints, once the colours are stripped:
//   src/pages/index.astro:2:7 - error ts(2322): Type 'string' is not assignable to type 'number'.
// followed by a code frame, which is skipped.
const ASTRO = /^(.+?):(\d+):(\d+) - (error|warning|hint) (ts\(\d+\)|[\w-]+\(?\d*\)?):\s*(.*)$/;

export function parseAstroCheck(output: string): TscProblem[] {
  const out: TscProblem[] = [];
  for (const raw of output.split("\n")) {
    const m = cleanLine(raw).match(ASTRO);
    if (!m) continue;
    const ts = /^ts\((\d+)\)$/.exec(m[5]);
    out.push({
      file: m[1],
      line: Number(m[2]),
      column: Number(m[3]),
      severity: m[4] === "error" ? "error" : m[4] === "warning" ? "warning" : "message",
      code: ts ? `TS${ts[1]}` : m[5],
      message: m[6],
    });
  }
  return out;
}

interface EslintFile {
  filePath: string;
  messages: { ruleId: string | null; severity: number; message: string; line?: number; column?: number; fatal?: boolean }[];
}

// eslint --format json: an array of files, each with its messages. Paths are absolute.
export function parseEslintJson(output: string): TscProblem[] {
  const start = output.indexOf("[");
  if (start < 0) return [];
  let files: EslintFile[];
  try {
    files = JSON.parse(output.slice(start)) as EslintFile[];
  } catch {
    return [];
  }
  const out: TscProblem[] = [];
  for (const f of files) {
    for (const m of f.messages ?? []) {
      const severity: Severity = m.severity === 2 || m.fatal ? "error" : "warning";
      out.push({
        file: f.filePath,
        line: m.line ?? 1,
        column: m.column ?? 1,
        severity,
        code: m.ruleId ?? "eslint",
        message: m.message,
      });
    }
  }
  return out;
}
