import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { hashJSON } from "../kernel/hashing";
import { createReceipt, IntegrityReceipt } from "../kernel/receipt";
import { appendTransparencyLog } from "../kernel/transparencyLog";

function nowISO() {
  return new Date().toISOString();
}

export type EvidenceBundle = {
  engine: "e9.bundle";
  created_at: string;
  run_id: string;

  verdict: "PASS" | "WARN" | "FAIL";
  trust_score: number;

  pointers: {
    e2_chunk_index: string;
    e3_manifest: string;
    e3_verdict?: string | null;
    e4_contamination: string;
    e5_policy: string;
    e6_streaming?: string | null;
    e7_trust: string;
    e8_proofs: string;
  };

  artifacts: {
    e2: any;
    e3_manifest: any;
    e3_verdict?: any | null;
    e4: any;
    e5: any;
    e6?: any | null;
    e7: any;
    e8: any;
  };

  receipts: Record<string, any>;
  bundle_hash: string;
};

export async function runEngine9Bundle(args: {
  run_id: string;
  baseDir: string;
  outDir?: string;

  e2_chunk_index_path: string;
  e3_manifest_path: string;
  e3_verdict_path?: string | null;
  e4_path: string;
  e5_path: string;
  e6_path?: string | null;
  e7_path: string;
  e8_path: string;

  receipt_paths: Record<string, string>; // e2..e8 receipt json paths
}): Promise<{
  bundle_path: string;
  receipt_path: string;
  receipt: IntegrityReceipt;
  transparency_log_path: string;
  transparency_entry_hash: string;
}> {
  const outDir = args.outDir ?? path.join(args.baseDir, "runs", args.run_id);
  await fs.mkdir(outDir, { recursive: true });

  const e2 = JSON.parse(await fs.readFile(args.e2_chunk_index_path, "utf8"));
  const e3m = JSON.parse(await fs.readFile(args.e3_manifest_path, "utf8"));
  const e3v = args.e3_verdict_path ? JSON.parse(await fs.readFile(args.e3_verdict_path, "utf8")) : null;
  const e4 = JSON.parse(await fs.readFile(args.e4_path, "utf8"));
  const e5 = JSON.parse(await fs.readFile(args.e5_path, "utf8"));
  const e6 = args.e6_path ? JSON.parse(await fs.readFile(args.e6_path, "utf8")) : null;
  const e7 = JSON.parse(await fs.readFile(args.e7_path, "utf8"));
  const e8 = JSON.parse(await fs.readFile(args.e8_path, "utf8"));

  const receipts: Record<string, any> = {};
  for (const [k, p] of Object.entries(args.receipt_paths)) {
    receipts[k] = JSON.parse(await fs.readFile(p, "utf8"));
  }

  const verdict = String(e7?.verdict ?? "WARN") as "PASS" | "WARN" | "FAIL";
  const trust_score = Number(e7?.score ?? 0);

  const bundleCore = {
    engine: "e9.bundle" as const,
    created_at: nowISO(),
    run_id: args.run_id,
    verdict,
    trust_score,
    pointers: {
      e2_chunk_index: path.basename(args.e2_chunk_index_path),
      e3_manifest: path.basename(args.e3_manifest_path),
      e3_verdict: args.e3_verdict_path ? path.basename(args.e3_verdict_path) : null,
      e4_contamination: path.basename(args.e4_path),
      e5_policy: path.basename(args.e5_path),
      e6_streaming: args.e6_path ? path.basename(args.e6_path) : null,
      e7_trust: path.basename(args.e7_path),
      e8_proofs: path.basename(args.e8_path),
    },
    artifacts: { e2, e3_manifest: e3m, e3_verdict: e3v, e4, e5, e6, e7, e8 },
    receipts,
  };

  const bundle_hash = hashJSON(bundleCore);

  const bundle: EvidenceBundle = {
    ...(bundleCore as any),
    bundle_hash,
  };

  const bundle_path = path.join(outDir, "e9.bundle.json");
  await fs.writeFile(bundle_path, JSON.stringify(bundle, null, 2), "utf8");

  const receipt = createReceipt({
    engine: "e9.bundle",
    run_id: args.run_id,
    created_at: nowISO(),
    inputs: { pointers: bundle.pointers },
    params: {},
    outputs: { bundle: path.basename(bundle_path), bundle_hash, verdict, trust_score },
    environment: {
      node: process.version,
      platform: os.platform(),
      arch: os.arch(),
      cpus: os.cpus()?.length ?? null,
    },
  });

  const receipt_path = path.join(outDir, "e9.receipt.json");
  await fs.writeFile(receipt_path, JSON.stringify(receipt, null, 2), "utf8");

  const tl = await appendTransparencyLog({
    baseDir: args.baseDir,
    receipt_hash: receipt.receipt_hash,
    timestampISO: receipt.created_at,
  });

  return {
    bundle_path,
    receipt_path,
    receipt,
    transparency_log_path: tl.log_path,
    transparency_entry_hash: tl.entry_hash,
  };
}
