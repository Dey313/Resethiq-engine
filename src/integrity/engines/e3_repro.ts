import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { hashHex, hashJSON } from "../kernel/hashing";
import { createReceipt, IntegrityReceipt } from "../kernel/receipt";
import { appendTransparencyLog } from "../kernel/transparencyLog";

type E2ChunkIndex = {
  run_id: string;
  dataset_id: string;
  rows: number;
  merkle_root: string;
  chunking: { mode: string; chunk_rows: number };
  leaves: Array<{ chunk_id: number; start_row: number; end_row: number; leaf_hash: string }>;
};

export type ReproManifest = {
  engine: "e3.repro_manifest";
  created_at: string;
  run_id: string;

  // what we are attesting about
  dataset: {
    dataset_id: string;
    input_file: string;
    input_bytes: number;
    input_digest_sha256: string;
    e2_chunk_index_hash_sha256: string;
    merkle_root: string;
    rows: number;
    chunk_rows: number;
    leaf_count: number;
  };

  environment: {
    node: string;
    platform: string;
    arch: string;
    cpus: number | null;
  };
};

export type ReplayVerdict = {
  engine: "e3.replay_verdict";
  created_at: string;
  run_id: string;
  against_run_id: string;

  verdict: "MATCH" | "MISMATCH";
  compared: {
    merkle_root: boolean;
    input_digest_sha256: boolean;
    e2_chunk_index_hash_sha256: boolean;
    rows: boolean;
    chunk_rows: boolean;
    leaf_count: boolean;
  };

  // if mismatch, summarize where
  delta?: Record<string, { left: any; right: any }>;
};

export type Engine3Result = {
  run_id: string;
  manifest_path: string;
  verdict_path?: string;
  receipt_path: string;
  receipt: IntegrityReceipt;
  transparency_log_path: string;
  transparency_entry_hash: string;
};

function nowISO() {
  return new Date().toISOString();
}

async function sha256FileHex(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    const s = fssync.createReadStream(filePath);
    s.on("data", (chunk) => h.update(chunk));
    s.on("error", reject);
    s.on("end", () => resolve(h.digest("hex")));
  });
}

export async function runEngine3Repro(args: {
  run_id: string;

  baseDir: string;             // e.g. ".resethiq"
  outDir?: string;             // default `${baseDir}/runs/${run_id}`

  input_csv_path: string;

  // Engine 2 artifacts (paths)
  e2_chunk_index_path: string; // e.g. `${outDir}/e2.chunk_index.json`
  e2_receipt_hash?: string;    // chain link if available

  // Optional: compare against a previous run id
  compare_against_run_id?: string;
}): Promise<Engine3Result> {
  const outDir = args.outDir ?? path.join(args.baseDir, "runs", args.run_id);
  await fs.mkdir(outDir, { recursive: true });

  // Load E2 chunk index
  const e2Raw = await fs.readFile(args.e2_chunk_index_path, "utf8");
  const e2: E2ChunkIndex = JSON.parse(e2Raw);

  // Hash the chunk index file deterministically
  const e2_chunk_index_hash_sha256 = hashHex(Buffer.from(e2Raw, "utf8"));

  // Digest the input file (streamed)
  const st = await fs.stat(args.input_csv_path);
  const input_digest_sha256 = await sha256FileHex(args.input_csv_path);

  const manifest: ReproManifest = {
    engine: "e3.repro_manifest",
    created_at: nowISO(),
    run_id: args.run_id,
    dataset: {
      dataset_id: e2.dataset_id,
      input_file: path.basename(args.input_csv_path),
      input_bytes: st.size,
      input_digest_sha256,
      e2_chunk_index_hash_sha256,
      merkle_root: e2.merkle_root,
      rows: e2.rows,
      chunk_rows: e2.chunking?.chunk_rows ?? null,
      leaf_count: Array.isArray(e2.leaves) ? e2.leaves.length : 0,
    },
    environment: {
      node: process.version,
      platform: os.platform(),
      arch: os.arch(),
      cpus: os.cpus()?.length ?? null,
    },
  };

  const manifest_path = path.join(outDir, "e3.run_manifest.json");
  await fs.writeFile(manifest_path, JSON.stringify(manifest, null, 2), "utf8");

  // Optional: replay verdict
  let verdict_path: string | undefined;
  let verdict: ReplayVerdict | undefined;

  if (args.compare_against_run_id) {
    const otherDir = path.join(args.baseDir, "runs", args.compare_against_run_id);
    const otherManifestPath = path.join(otherDir, "e3.run_manifest.json");

    const otherRaw = await fs.readFile(otherManifestPath, "utf8");
    const other: ReproManifest = JSON.parse(otherRaw);

    const delta: Record<string, { left: any; right: any }> = {};
    function cmp(field: keyof ReproManifest["dataset"]) {
      const left = manifest.dataset[field];
      const right = other.dataset[field];
      if (left !== right) delta[String(field)] = { left, right };
      return left === right;
    }

    const compared = {
      merkle_root: cmp("merkle_root"),
      input_digest_sha256: cmp("input_digest_sha256"),
      e2_chunk_index_hash_sha256: cmp("e2_chunk_index_hash_sha256"),
      rows: cmp("rows"),
      chunk_rows: cmp("chunk_rows"),
      leaf_count: cmp("leaf_count"),
    };

    const verdictValue: "MATCH" | "MISMATCH" =
      Object.values(compared).every(Boolean) ? "MATCH" : "MISMATCH";

    verdict = {
      engine: "e3.replay_verdict",
      created_at: nowISO(),
      run_id: args.run_id,
      against_run_id: args.compare_against_run_id,
      verdict: verdictValue,
      compared,
      delta: verdictValue === "MISMATCH" ? delta : undefined,
    };

    verdict_path = path.join(outDir, "e3.replay_verdict.json");
    await fs.writeFile(verdict_path, JSON.stringify(verdict, null, 2), "utf8");
  }

  const receipt = createReceipt({
    engine: "e3.repro",
    run_id: args.run_id,
    created_at: nowISO(),
    inputs: {
      input_csv: path.basename(args.input_csv_path),
      e2_chunk_index: path.basename(args.e2_chunk_index_path),
      e2_receipt_hash: args.e2_receipt_hash ?? null,
      compare_against_run_id: args.compare_against_run_id ?? null,
    },
    params: {
      file_digest: "sha256",
      index_digest: "sha256",
    },
    outputs: {
      manifest: path.basename(manifest_path),
      manifest_hash: hashJSON(manifest),
      verdict: verdict_path ? path.basename(verdict_path) : null,
      verdict_hash: verdict ? hashJSON(verdict) : null,
    },
    environment: {
      node: process.version,
      platform: os.platform(),
      arch: os.arch(),
      cpus: os.cpus()?.length ?? null,
    },
    prev_receipt_hash: args.e2_receipt_hash,
  });

  const receipt_path = path.join(outDir, "e3.receipt.json");
  await fs.writeFile(receipt_path, JSON.stringify(receipt, null, 2), "utf8");

  const transparency = await appendTransparencyLog({
    baseDir: args.baseDir,
    receipt_hash: receipt.receipt_hash,
    timestampISO: receipt.created_at,
  });

  return {
    run_id: args.run_id,
    manifest_path,
    verdict_path,
    receipt_path,
    receipt,
    transparency_log_path: transparency.log_path,
    transparency_entry_hash: transparency.entry_hash,
  };
}
