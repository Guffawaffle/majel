import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { AxCommand, AxResult } from "./types.js";
import { ROOT, getFlag, hasFlag, makeResult } from "./runner.js";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

function sanitizedName(input: string): string {
  return input.replace(/[\\/]/g, "-").trim();
}

function nowStamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

const command: AxCommand = {
  name: "tmp",
  description: "Write/read workspace temp files under tmp/ax (supports stdin)",

  async run(args): Promise<AxResult> {
    const start = Date.now();
    const baseDir = resolve(ROOT, "tmp", "ax");
    await mkdir(baseDir, { recursive: true });

    const readMode = hasFlag(args, "read");
    const appendMode = hasFlag(args, "append");
    const nameFlag = getFlag(args, "name");
    const ext = getFlag(args, "ext") ?? "md";

    const fileName = nameFlag && nameFlag.trim().length > 0
      ? sanitizedName(nameFlag)
      : `ax-${nowStamp()}.${ext}`;
    const filePath = resolve(baseDir, fileName);

    if (readMode) {
      try {
        const content = await readFile(filePath, "utf-8");
        return makeResult("tmp", start, {
          action: "read",
          baseDir,
          fileName,
          filePath,
          bytes: Buffer.byteLength(content, "utf-8"),
          content,
        });
      } catch (error) {
        return makeResult("tmp", start, {
          action: "read",
          baseDir,
          fileName,
          filePath,
        }, {
          success: false,
          errors: [error instanceof Error ? error.message : String(error)],
        });
      }
    }

    const contentFlag = getFlag(args, "content");
    const hasStdin = !process.stdin.isTTY;
    const stdinContent = hasStdin ? await readStdin() : "";
    const finalContent = contentFlag ?? stdinContent;

    if (finalContent.length === 0) {
      return makeResult("tmp", start, {
        action: "write",
        baseDir,
        fileName,
        filePath,
      }, {
        success: false,
        errors: ["No content provided. Use --content or pipe stdin."],
        hints: [
          "Example: cat <<'EOF' | npm run ax -- tmp --name note.md",
          "Example: npm run ax -- tmp --name note.md --content 'hello'",
          "Read back: npm run ax -- tmp --read --name note.md",
        ],
      });
    }

    if (appendMode) {
      let existing = "";
      try {
        existing = await readFile(filePath, "utf-8");
      } catch {
        existing = "";
      }
      await writeFile(filePath, `${existing}${finalContent}`, "utf-8");
    } else {
      await writeFile(filePath, finalContent, "utf-8");
    }

    return makeResult("tmp", start, {
      action: appendMode ? "append" : "write",
      baseDir,
      fileName,
      filePath,
      bytes: Buffer.byteLength(finalContent, "utf-8"),
    }, {
      success: true,
      hints: [
        `Use with gh: gh issue comment <n> --body-file ${filePath}`,
      ],
    });
  },
};

export default command;
