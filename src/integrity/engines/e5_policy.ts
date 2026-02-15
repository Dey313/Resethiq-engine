import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { streamCsvRows, CsvRow } from "../io/csvStream";
import { createReceipt, IntegrityReceipt } from "../kernel/receipt";
import { appendTransparencyLog } from "../kernel/transparencyLog";

function nowISO() { return new Date().toISOString(); }

const RE_EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const RE_PHONE_IN = /\b(?:\+?91[-\s]?)?[6-9]\d{9}\b/;
const RE_AADHAAR = /\b\d{4}\s?\d{4}\s?\d{4}\b/;
const RE_PAN = /\b[A-Z]{5}\d{4}[A-Z]\b/i;

function valuesFromRow(row: CsvRow): Array<{ key: string; value: string }> {
  if (Array.isArray(row)) return row.map((v, i) => ({ key: `col_${i}`, value: String(v ?? "") }));
  return Object.keys(row).map((k) => ({ key: k, value: String((row as any)[k] ?? "") }));
}

export type PolicyReport = {
  engine: "e5.policy";
  created_at: string;
  run_id: string;
  input_file: string;

  scan: {
    rows_scanned: number;
    pii_hits_total: number;
  };

  column_risk: Record<string, { email: number; phone: number; aadhaar: number; pan: number; risk: "LOW" | "MEDIUM" | "HIGH" }>;

  dataset_risk: "LOW" | "MEDIUM" | "HIGH";
  notes: string[];
};

export async function runEngine5Policy(args: {
  run_id: string;
  baseDir: string;
  outDir?: string;
  input_csv_path: string;
  hasHeader?: boolean;
  delimiter?: string;
  maxScanRows?: number; // default 20000 (policy scan sampling)
}): Promise<{
  report_path: string;
  receipt_path: string;
  receipt: IntegrityReceipt;
  transparency_log_path: string;
  transparency_entry_hash: string;
}> {
  const outDir = args.outDir ?? path.join(args.baseDir, "runs", args.run_id);
  await fs.mkdir(outDir, { recursive: true });

  const maxScanRows = args.maxScanRows ?? 20000;

  const counts: Record<string, { email: number; phone: number; aadhaar: number; pan: number }> = {};
  let rows = 0;
  let hits = 0;

  await streamCsvRows({
    filePath: args.input_csv_path,
    opts: { hasHeader: args.hasHeader ?? true, delimiter: args.delimiter ?? "," },
    onRow: async (row, idx) => {
      if (idx >= maxScanRows) return;
      rows = idx + 1;

      for (const { key, value } of valuesFromRow(row)) {
        counts[key] ??= { email: 0, phone: 0, aadhaar: 0, pan: 0 };

        if (RE_EMAIL.test(value)) { counts[key].email += 1; hits += 1; }
        if (RE_PHONE_IN.test(value)) { counts[key].phone += 1; hits += 1; }
        if (RE_AADHAAR.test(value)) { counts[key].aadhaar += 1; hits += 1; }
        if (RE_PAN.test(value)) { counts[key].pan += 1; hits += 1; }
      }
    },
  });

  const column_risk: PolicyReport["column_risk"] = {};
  for (const [col, c] of Object.entries(counts)) {
    const score = c.email + c.phone + c.aadhaar * 2 + c.pan * 2;
    const risk = score >= 10 ? "HIGH" : score >= 3 ? "MEDIUM" : "LOW";
    column_risk[col] = { ...c, risk };
  }

  const highCols = Object.values(column_risk).filter((x) => x.risk === "HIGH").length;
  const dataset_risk: PolicyReport["dataset_risk"] =
    highCols >= 1 ? "HIGH" : hits >= 5 ? "MEDIUM" : "LOW";

  const report: PolicyReport = {
    engine: "e5.policy",
    created_at: nowISO(),
    run_id: args.run_id,
    input_file: path.basename(args.input_csv_path),
    scan: { rows_scanned: rows, pii_hits_total: hits },
    column_risk,
    dataset_risk,
    notes: [
      "E5 is a heuristic PII surface scan for governance risk triage.",
      "Use in combination with consent metadata + data processing agreements in regulated settings.",
      `Scans up to ${maxScanRows} rows for performance predictability.`,
    ],
  };

  const report_path = path.join(outDir, "e5.policy.json");
  await fs.writeFile(report_path, JSON.stringify(report, null, 2), "utf8");

  const receipt = createReceipt({
    engine: "e5.policy",
    run_id: args.run_id,
    created_at: nowISO(),
    inputs: { input_csv: path.basename(args.input_csv_path) },
    params: { maxScanRows },
    outputs: { report: path.basename(report_path), dataset_risk },
    environment: {
      node: process.version,
      platform: os.platform(),
      arch: os.arch(),
      cpus: os.cpus()?.length ?? null,
    },
  });

  const receipt_path = path.join(outDir, "e5.receipt.json");
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
