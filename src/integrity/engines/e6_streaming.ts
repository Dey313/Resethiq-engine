import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createReceipt, IntegrityReceipt } from "../kernel/receipt";
import { appendTransparencyLog } from "../kernel/transparencyLog";

function nowISO() {
  return new Date().toISOString();
}

export type StreamingCheckpoint = {
  engine: "e6.streaming";
  created_at: string;
  run_id: string;
  checkpoint: {
    outDir: string;
    artifacts_present: string[];
  };
  note: string;
};

export async function runEngine6StreamingCheckpoint(args: {
  run_id: string;
  baseDir: string;
  outDir?: string;
}): Promise<{
  checkpoint_path: string;
  receipt_path: string;
  receipt: IntegrityReceipt;
  transparency_log_path: string;
  transparency_entry_hash: string;
}> {
  const outDir = args.outDir ?? path.join(args.baseDir, "runs", args.run_id);
  await fs.mkdir(outDir, { recursive: true });

  const entries = await fs.readdir(outDir).catch(() => []);
  const ckpt: StreamingCheckpoint = {
    engine: "e6.streaming",
    created_at: nowISO(),
    run_id: args.run_id,
    checkpoint: { outDir, artifacts_present: entries.sort() },
    note:
      "E6 is a restart boundary: downstream engines can verify artifact presence and avoid recomputation. Extend to true resumable chunking if desired.",
  };

  const checkpoint_path = path.join(outDir, "e6.streaming.json");
  await fs.writeFile(checkpoint_path, JSON.stringify(ckpt, null, 2), "utf8");

  const receipt = createReceipt({
    engine: "e6.streaming",
    run_id: args.run_id,
    created_at: nowISO(),
    inputs: {},
    params: {},
    outputs: {
      checkpoint: path.basename(checkpoint_path),
      artifacts: ckpt.checkpoint.artifacts_present.length,
    },
    environment: {
      node: process.version,
      platform: os.platform(),
      arch: os.arch(),
      cpus: os.cpus()?.length ?? null,
    },
  });

  const receipt_path = path.join(outDir, "e6.receipt.json");
  await fs.writeFile(receipt_path, JSON.stringify(receipt, null, 2), "utf8");

  const tl = await appendTransparencyLog({
    baseDir: args.baseDir,
    receipt_hash: receipt.receipt_hash,
    timestampISO: receipt.created_at,
  });

  return {
    checkpoint_path,
    receipt_path,
    receipt,
    transparency_log_path: tl.log_path,
    transparency_entry_hash: tl.entry_hash,
  };
}
