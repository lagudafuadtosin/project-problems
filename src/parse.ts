// Reads tsc's watch-mode output (with --pretty false) and turns it into plain
// error records. Kept free of the VS Code API so it can be tested with Node.

export type Severity = "error" | "warning" | "message";

export interface TscProblem {
  file: string | null; // as printed, relative to the tsconfig's folder; null for project-level errors
  line: number; // 1-based, 0 when there is no location
  column: number;
  severity: Severity;
  code: string; // "TS2322"
  message: string;
}

// ESC [ ... letter: the screen clears tsc prints at the start of each run.
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;
// "08:11:19 PM - " or "[8:11:19 PM] " before the watch status lines.
const TIMESTAMP = /^\[?\s*\d{1,2}:\d{2}:\d{2}(?:\s*[AP]M)?\]?\s*-?\s*/i;
const LOCATED = /^(.+?)\((\d+),(\d+)\): (error|warning|message) (TS\d+): (.*)$/;
const UNLOCATED = /^(error|warning|message) (TS\d+): (.*)$/;
const RUN_START = /(Starting compilation in watch mode|File change detected\. Starting incremental compilation)/i;
const RUN_END = /Found \d+ errors?\b|Watching for file changes/i;

const MAX_LINE = 1_000_000;

export function cleanLine(raw: string): string {
  return raw.replace(ANSI, "").replace(/\r$/, "");
}

// Feed it chunks of stdout; it calls onRun with the full problem list each
// time tsc finishes a pass, so a fixed error disappears on the next pass.
export class WatchParser {
  private buffer = "";
  private current: TscProblem[] = [];
  private last: TscProblem | null = null;

  constructor(
    private readonly onRun: (problems: TscProblem[]) => void,
    private readonly onRunStart: () => void = () => {},
  ) {}

  push(chunk: string): void {
    this.buffer += chunk;
    // A line longer than this is not real compiler output; dropping it keeps
    // memory flat if something floods the pipe without line breaks.
    if (this.buffer.length > MAX_LINE && this.buffer.indexOf("\n") < 0) {
      this.buffer = "";
      return;
    }
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      this.line(this.buffer.slice(0, nl));
      this.buffer = this.buffer.slice(nl + 1);
    }
  }

  private line(raw: string): void {
    const text = cleanLine(raw);
    const status = text.replace(TIMESTAMP, "");
    if (RUN_START.test(status)) {
      this.current = [];
      this.last = null;
      this.onRunStart();
      return;
    }
    if (RUN_END.test(status)) {
      this.onRun(this.current);
      this.current = [];
      this.last = null;
      return;
    }
    const located = text.match(LOCATED);
    if (located) {
      this.last = {
        file: located[1],
        line: Number(located[2]),
        column: Number(located[3]),
        severity: located[4] as Severity,
        code: located[5],
        message: located[6],
      };
      this.current.push(this.last);
      return;
    }
    const unlocated = text.match(UNLOCATED);
    if (unlocated) {
      this.last = { file: null, line: 0, column: 0, severity: unlocated[1] as Severity, code: unlocated[2], message: unlocated[3] };
      this.current.push(this.last);
      return;
    }
    // Indented lines continue the previous message ("  Type 'x' is not ...").
    if (this.last && /^\s+\S/.test(text)) this.last.message += "\n" + text.trim();
  }
}
