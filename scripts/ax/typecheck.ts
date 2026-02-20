/**
 * ax/typecheck.ts — TypeScript compilation check with structured errors.
 */

import { relative } from "node:path";
import type { AxCommand, AxResult, TypecheckError } from "./types.js";
import { ROOT, runCapture, makeResult } from "./runner.js";

const command: AxCommand = {
  name: "typecheck",
  description: "TypeScript compilation check with structured errors",

  async run(_args): Promise<AxResult> {
    const start = Date.now();
    const result = runCapture("npx", ["tsc", "--noEmit", "--pretty", "false"], { ignoreExit: true });

    const errors: TypecheckError[] = [];
    const output = result.stdout + "\n" + result.stderr;

    // Parse TS errors: src/server/foo.ts(10,5): error TS2345: Argument of type...
    const errorPattern = /^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.+)$/gm;
    let match;
    while ((match = errorPattern.exec(output)) !== null) {
      errors.push({
        file: relative(ROOT, match[1]),
        line: Number(match[2]),
        col: Number(match[3]),
        code: match[4],
        message: match[5].trim(),
      });
    }

    return makeResult("typecheck", start, {
      errorCount: errors.length,
      errors: errors.slice(0, 50),
    }, {
      success: errors.length === 0,
      errors: errors.length > 0 ? [`${errors.length} type error(s)`] : undefined,
      hints: errors.length > 0
        ? ["Fix type errors then re-run", "Use --file flag to narrow scope"]
        : undefined,
    });
  },
};

export default command;
