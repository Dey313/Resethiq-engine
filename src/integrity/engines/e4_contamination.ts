import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { streamCsvRows, CsvRow } from "../io/csvStream";
import { createReceipt, IntegrityReceipt } from "../kernel/receipt";
import { appendTransparencyLog } from "../kernel/transparencyLog";

function nowISO() { return new Date().toISOString(); }

function rowToStableString(row: CsvRow): string {
  if (Array.isArray(row)) return row.map((v) => (v ?? "")).join("\u001f");
  const keys = Object.keys(row).sort();
  return keys.map((k) => `${k}=${row[k] ?? ""}`).join("\u001f");
}

function sha256Hex(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

export type ContaminationReport = {
  engine: "e4.contamination";
  created_at: string;
  run_id: string;
  input_file: string;

  stats: {
    rows: number;
    approx_unique_rows: number;
    duplicate_rows_est: number;
    duplicate_ratio_est: number;
  };

  signals: {
    heavy_repetition: boolean;
    very_low_uniqueness: boolean;
    high_exact_duplicates: boolean;
  };

  evidence: {
    top_repeated_row_hashes: Array<{ row_hash: string; count: number }>;
    note: string;
  };
};

export async function runEngine4Contamination(args: {
  run_id: string;
  baseDir: string;
  outDir?: string;
  input_csv_path: string;
  hasHeader?: boolean;
  delimiter?: string;

  // memory-safe counting (top-K frequent row hashes)
  heavyHittersK?: number;      // default 50
  repetitionFlagRatio?: number;// default 0.15
}): Promise<{
  report_path: string;
  receipt_path: string;
  receipt: IntegrityReceipt;
  transparency_log_path: string;
  transparency_entry_hash: string;
}> {
  const outDir = args.outDir ?? path.join(args.baseDir, "runs", args.run_id);
  await fs.mkdir(outDir, { recursive: true });

  const K = args.heavyHittersK ?? 50;
  const repFlag = args.repetitionFlagRatio ?? 0.15;

  // Space-Saving heavy hitters (approx)
  const counts = new Map<string, number>();

  let rows = 0;
  let approxUnique = 0;

  await streamCsvRows({
    filePath: args.input_csv_path,
    opts: { hasHeader: args.hasHeader ?? true, delimiter: args.delimiter ?? "," },
    onRow: async (row, idx) => {
      rows = idx + 1;
      const h = sha256Hex(rowToStableString(row));

      if (counts.has(h)) {
        counts.set(h, (counts.get(h) ?? 0) + 1);
      } else if (counts.size < K) {
        counts.set(h, 1);
        approxUnique += 1;
      } else {
        // decrement all by 1 (space-saving-ish)
        for (const [k, v] of counts.entries()) {
          const nv = v - 1;
          if (nv <= 0) counts.delete(k);
          else counts.set(k, nv);
        }
      }
    },
  });

  // Estimate duplicates: rows - approxUnique (very rough)
  const duplicateEst = Math.max(0, rows - approxUnique);
  const duplicateRatio = rows === 0 ? 0 : duplicateEst / rows;

  const top = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([row_hash, count]) => ({ row_hash, count }));

  const report: ContaminationReport = {
    engine: "e4.contamination",
    created_at: nowISO(),
    run_id: args.run_id,
    input_file: path.basename(args.input_csv_path),
    stats: {
      rows,
      approx_unique_rows: approxUnique,
      duplicate_rows_est: duplicateEst,
      duplicate_ratio_est: Number(duplicateRatio.toFixed(6)),
    },
    signals: {
      heavy_repetition: duplicateRatio >= repFlag,
      very_low_uniqueness: rows > 0 ? (approxUnique / rows) < 0.65 : false,
      high_exact_duplicates: duplicateRatio >= 0.25,
    },
    evidence: {
      top_repeated_row_hashes: top,
      note:
        "E4 uses streaming heavy-hitter approximation; results are conservative indicators. Combine with E3 replay verdict + E2 Merkle for evidence-grade assessment.",
    },
  };

  const report_path = path.join(outDir, "e4.contamination.json");
  await fs.writeFile(report_path, JSON.stringify(report, null, 2), "utf8");

  const receipt = createReceipt({
    engine: "e4.contamination",
    run_id: args.run_id,
    created_at: nowISO(),
    inputs: { input_csv: path.basename(args.input_csv_path) },
    params: { heavyHittersK: K, repetitionFlagRatio: repFlag },
    outputs: { report: path.basename(report_path) },
    environment: {
      node: process.version,
      platform: os.platform(),
      arch: os.arch(),
      cpus: os.cpus()?.length ?? null,
    },
  });

  const receipt_path = path.join(outDir, "e4.receipt.json");
  await fs.writeFile(receipt_path, JSON.stringify(receipt, null, 2), "utf8");

  const tl = await appendTransparencyLog({
    baseDir: args.baseDir,
    receipt_hash: receipt.receipt_hash,
    timestampISO: receipt.created_at,
  });

  return {
    report_path,
    receipt_path,
    receipt,
    transparency_log_path: tl.log_path,
    transparency_entry_hash: tl.entry_hash,
  };
}
