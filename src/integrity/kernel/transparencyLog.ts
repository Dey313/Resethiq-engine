import fs from "node:fs/promises";
import path from "node:path";
import { hashHex } from "./hashing";

export type LogAppendResult = {
  log_path: string;
  entry_hash: string;
  prev_hash: string;
};

/**
 * Append-only transparency log (hash-chained).
 * line format: timestamp \t receipt_hash \t prev_hash \t entry_hash
 */
export async function appendTransparencyLog(args: {
  baseDir: string;          // e.g. ".resethiq"
  receipt_hash: string;
  timestampISO?: string;
}): Promise<LogAppendResult> {
  const { baseDir, receipt_hash } = args;
  const timestamp = args.timestampISO ?? new Date().toISOString();

  await fs.mkdir(baseDir, { recursive: true });
  const log_path = path.join(baseDir, "transparency.log");

  let prev_hash = "GENESIS";
  try {
    const existing = await fs.readFile(log_path, "utf8");
    const lines = existing.trim().split("\n").filter(Boolean);
    if (lines.length > 0) {
      const last = lines[lines.length - 1];
      const parts = last.split("\t");
      prev_hash = parts[3] ?? "GENESIS";
    }
  } catch {
    // first write
  }

  const payload = Buffer.from(`${prev_hash}\n${receipt_hash}\n${timestamp}`, "utf8");
  const entry_hash = hashHex(payload);

  const line = `${timestamp}\t${receipt_hash}\t${prev_hash}\t${entry_hash}\n`;
  await fs.appendFile(log_path, line, "utf8");

  return { log_path, entry_hash, prev_hash };
}
