import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";

// True when a path sits inside one of the given folders. The extension only
// follows configs, and only runs a TypeScript install, inside the folders the
// user opened and trusted; a reference like "../../elsewhere" is ignored.
export function isInside(file: string, roots: string[]): boolean {
  const norm = (p: string) => {
    const r = path.resolve(p);
    return process.platform === "win32" ? r.toLowerCase() : r;
  };
  const f = norm(file);
  return roots.some((root) => {
    const r = norm(root);
    return f === r || f.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
  });
}

// tsconfig files allow comments and trailing commas, which JSON.parse does not.
export function parseJsonc(text: string): unknown {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inString) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else {
      out += c;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

// A "solution" tsconfig only lists references and checks no files itself;
// each referenced project is found and checked on its own instead.
export function isSolutionConfig(tsconfigPath: string): boolean {
  try {
    const cfg = parseJsonc(readFileSync(tsconfigPath, "utf8")) as { files?: unknown[]; include?: unknown[]; references?: unknown[] };
    return Array.isArray(cfg.references) && Array.isArray(cfg.files) && cfg.files.length === 0 && !cfg.include;
  } catch {
    return false;
  }
}

export interface Compiler {
  script: string; // the tsc entry script, run with VS Code's own Node
  version: string;
}

// The TypeScript the project itself installs, found by walking up the folders
// (so hoisted monorepo installs work), so the errors match the project's own
// build. VS Code ships only the editor half of TypeScript, not tsc, so there
// is nothing to fall back to when a project has none installed.
export function findCompiler(projectDir: string, roots: string[]): Compiler | null {
  try {
    const req = createRequire(path.join(projectDir, "noop.js"));
    const pkgPath = req.resolve("typescript/package.json");
    // Walking up must not leave the trusted folders: a TypeScript found in a
    // parent folder (a home-directory install, say) is code the user never trusted.
    if (!isInside(pkgPath, roots)) return null;
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string; bin?: Record<string, string> };
    const bin = pkg.bin?.tsc;
    if (!bin) return null;
    const script = path.join(path.dirname(pkgPath), bin);
    return existsSync(script) ? { script, version: pkg.version } : null;
  } catch {
    return null;
  }
}

// The configs a tsconfig points to under "references". A path can name a
// folder (meaning its tsconfig.json) or a config file directly.
export function referencedConfigs(tsconfigPath: string): string[] {
  try {
    const cfg = parseJsonc(readFileSync(tsconfigPath, "utf8")) as { references?: { path?: string }[] };
    const out: string[] = [];
    for (const ref of cfg.references ?? []) {
      if (typeof ref?.path !== "string") continue;
      const target = path.resolve(path.dirname(tsconfigPath), ref.path);
      const file = target.toLowerCase().endsWith(".json") ? target : path.join(target, "tsconfig.json");
      if (existsSync(file)) out.push(file);
    }
    return out;
  } catch {
    return [];
  }
}

// Every config worth checking: the ones found on disk plus everything they
// reference (Vite's tsconfig.app.json and tsconfig.node.json, monorepo
// packages), minus link-only "solution" configs that check no files.
export function projectConfigs(found: string[], roots: string[]): string[] {
  const seen = new Set<string>();
  const queue = found.map((f) => path.resolve(f)).filter((f) => isInside(f, roots));
  const out: string[] = [];
  while (queue.length) {
    const next = queue.shift()!;
    const key = process.platform === "win32" ? next.toLowerCase() : next;
    if (seen.has(key)) continue;
    seen.add(key);
    queue.push(...referencedConfigs(next).filter((r) => isInside(r, roots)));
    if (!isSolutionConfig(next)) out.push(next);
  }
  return out;
}

// Enough glob support for exclude settings: ** (any folders), * and ?.
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 2;
      } else {
        re += ".*";
        i += 1;
      }
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "i");
}
