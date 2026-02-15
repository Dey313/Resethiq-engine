import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createReceipt, IntegrityReceipt } from "../kernel/receipt";
import { appendTransparencyLog } from "../kernel/transparencyLog";
import { merkleProof, verifyProof } from "../../core/merkle";

function nowISO() { return new Date().toISOString(); }

type E2ChunkIndex = {
  merkle_root: string;
  leaves: Array<{ leaf_hash: string }>;
};

export type ProofBundle = {
  engine: "e8.proofs";
  created_at: string;
  run_id: string;
  merkle_root: string;
  algorithm: "blake2b512"; // matches your src/core/merkle.ts implementation
  sampled: Array<{
    index: number;
    leaf_hex: string;
    siblings_hex: string[];
    verifies: boolean;
  }>;
};

function sampleIndices(n: number, k: number): number[] {
  if (n <= 0) return [];
  const out = new Set<number>();
  const target = Math.min(k, n);
  while (out.size < target) {
    out.add(Math.floor(Math.random() * n));
  }
  return Array.from(out).sort((a, b) => a - b);
}

export async function runEngine8ProofSampler(args: {
  run_id: string;
  baseDir: string;
  outDir?: string;
  e2_chunk_index_path: string;
  sampleCount?: number; // default 8
}): Promise<{
  proofs_path: string;
  receipt_path: string;
  receipt: IntegrityReceipt;
  transparency_log_path: string;
  transparency_entry_hash: string;
}> {
  const outDir = args.outDir ?? path.join(args.baseDir, "runs", args.run_id);
  await fs.mkdir(outDir, { recursive: true });

  const raw = await fs.readFile(args.e2_chunk_index_path, "utf8");
  const e2: E2ChunkIndex = JSON.parse(raw);

  const leafHex = (e2.leaves ?? []).map((l) => l.leaf_hash);
  const rootHex = e2.merkle_root;

  const idxs = sampleIndices(leafHex.length, args.sampleCount ?? 8);

  const sampled = idxs.map((i) => {
    const p = merkleProof(leafHex, i);
    const ok = verifyProof(rootHex, p);
    return { index: i, leaf_hex: p.leaf_hex, siblings_hex: p.siblings_hex, verifies: ok };
  });

  const bundle: ProofBundle = {
    engine: "e8.proofs",
    created_at: nowISO(),
    run_id: args.run_id,
    merkle_root: rootHex,
    algorithm: "blake2b512",
    sampled,
  };

  const proofs_path = path.join(outDir, "e8.proofs.json");
  await fs.writeFile(proofs_path, JSON.stringify(bundle, null, 2), "utf8");

  const receipt = createReceipt({
    engine: "e8.proofs",
    run_id: args.run_id,
    created_at: nowISO(),
    inputs: { e2_chunk_index: path.basename(args.e2_chunk_index_path) },
    params: { sampleCount: args.sampleCount ?? 8 },
    outputs: { proofs: path.basename(proofs_path), sampled: sampled.length },
    environment: {
      node: process.version,
      platform: os.platform(),
      arch: os.arch(),
      cpus: os.cpus()?.length ?? null,
    },
  });

  const receipt_path = path.join(outDir, "e8.receipt.json");
  await fs.writeFile(receipt_path, JSON.stringify(receipt, null, 2), "utf8");

  const tl = await appendTransparencyLog({
    baseDir: args.baseDir,
    receipt_hash: receipt.receipt_hash,
    timestampISO: receipt.created_at,
  });

  return {
    proofs_path,
    receipt_path,
    receipt,
    transparency_log_path: tl.log_path,
    transparency_entry_hash: tl.entry_hash,
  };
}
