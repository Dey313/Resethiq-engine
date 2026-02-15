import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { streamCsvRows, CsvRow } from "../io/csvStream";
import { hashBytes, hashHex, hashJSON } from "../kernel/hashing";
import { createReceipt, IntegrityReceipt } from "../kernel/receipt";
import { appendTransparencyLog } from "../kernel/transparencyLog";

export type MerkleLeaf = {
  chunk_id: number;
  start_row: number;
  end_row: number;   // inclusive
  leaf_hash: string; // hex
};

export type MerkleAttestationResult = {
  run_id: string;
  dataset_id: string;
  rows: number;

  chunk_rows: number;
  leaves: MerkleLeaf[];
  merkle_root: string;

  chunk_index_path: string;
  receipt_path: string;
  receipt: IntegrityReceipt;

  transparency_log_path: string;
  transparency_entry_hash: string;
};

function nowISO() {
  return new Date().toISOString();
}

function merkleParent(aHex: string, bHex: string): string {
  const a = Buffer.from(aHex, "hex");
  const b = Buffer.from(bHex, "hex");
  return hashHex(Buffer.concat([a, b]));
}

/**
 * Build a Merkle root from leaf hashes. If odd nodes at a level, duplicate last.
 */
export function buildMerkleRoot(leafHashesHex: string[]): string {
  if (leafHashesHex.length === 0) return hashHex(Buffer.from("EMPTY", "utf8"));
  let level = leafHashesHex.slice();
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = (i + 1 < level.length) ? level[i + 1] : level[i];
      next.push(merkleParent(left, right));
    }
    level = next;
  }
  return level[0];
}

/**
 * Deterministic row normalization for chunk hashing:
 * - object rows: keys sorted
 * - array rows: join with unit separator
 *
 * (Engine 1 canonicalization will later be the stricter, full spec.)
 */
function normalizeRow(row: CsvRow): string {
  if (Array.isArray(row)) {
    return row.map((v) => (v ?? "")).join("\u001f");
  }
  const keys = Object.keys(row).sort();
  return keys.map((k) => `${k}=${(row[k] ?? "")}`).join("\u001f");
}

export async function runEngine2MerkleAttest(args: {
  run_id: string;
  input_csv_path: string;

  baseDir: string;      // e.g. ".resethiq"
  outDir?: string;      // default `${baseDir}/runs/${run_id}`

  chunk_rows?: number;  // default 5000
  hasHeader?: boolean;
  delimiter?: string;
}): Promise<MerkleAttestationResult> {
  const chunk_rows = args.chunk_rows ?? 5000;
  const outDir = args.outDir ?? path.join(args.baseDir, "runs", args.run_id);

  await fs.mkdir(outDir, { recursive: true });

  const st = await fs.stat(args.input_csv_path);

  // Stable dataset_id (for now): filename + size + mtime.
  // Later: replace with Engine 1 canonical dataset descriptor hash.
  const dataset_id = hashJSON({
    filename: path.basename(args.input_csv_path),
    size: st.size,
    mtimeMs: st.mtimeMs,
  });

  const leaves: MerkleLeaf[] = [];
  let rows = 0;

  let currentChunkStart = 0;
  let currentChunkRows: string[] = [];
  let chunk_id = 0;

  async function finalizeChunk(start_row: number, end_row: number) {
    const payload = currentChunkRows.join("\n");
    const leaf_hash = hashHex(hashBytes(Buffer.from(payload, "utf8")));
    leaves.push({ chunk_id, start_row, end_row, leaf_hash });
    currentChunkRows = [];
    chunk_id += 1;
  }

  await streamCsvRows({
    filePath: args.input_csv_path,
    opts: { hasHeader: args.hasHeader ?? true, delimiter: args.delimiter ?? "," },
    onRow: async (row: CsvRow, idx: number) => {
      rows = idx + 1;
      currentChunkRows.push(normalizeRow(row));

      if (currentChunkRows.length >= chunk_rows) {
        await finalizeChunk(currentChunkStart, idx);
        currentChunkStart = idx + 1;
      }
    },
  });

  if (currentChunkRows.length > 0) {
    await finalizeChunk(currentChunkStart, rows - 1);
  }

  const merkle_root = buildMerkleRoot(leaves.map((l) => l.leaf_hash));

  const chunkIndex = {
    engine: "e2.merkle_attest",
    created_at: nowISO(),
    run_id: args.run_id,
    dataset_id,
    input: { file: path.basename(args.input_csv_path), bytes: st.size },
    chunking: { mode: "rows", chunk_rows },
    rows,
    merkle_root,
    leaves,
  };

  const chunk_index_path = path.join(outDir, "e2.chunk_index.json");
  await fs.writeFile(chunk_index_path, JSON.stringify(chunkIndex, null, 2), "utf8");

  const receipt = createReceipt({
    engine: "e2.merkle_attest",
    run_id: args.run_id,
    created_at: nowISO(),
    inputs: { dataset_id, input_csv: path.basename(args.input_csv_path) },
    params: {
      chunk_rows,
      hash: "sha256",
      delimiter: args.delimiter ?? ",",
      hasHeader: args.hasHeader ?? true,
    },
    outputs: {
      rows,
      leaves: leaves.length,
      merkle_root,
      chunk_index: path.basename(chunk_index_path),
    },
    environment: {
      node: process.version,
      platform: os.platform(),
      arch: os.arch(),
      cpus: os.cpus()?.length ?? null,
    },
  });

  const receipt_path = path.join(outDir, "e2.receipt.json");
  await fs.writeFile(receipt_path, JSON.stringify(receipt, null, 2), "utf8");

  const transparency = await appendTransparencyLog({
    baseDir: args.baseDir,
    receipt_hash: receipt.receipt_hash,
    timestampISO: receipt.created_at,
  });

  return {
    run_id: args.run_id,
    dataset_id,
    rows,
    chunk_rows,
    leaves,
    merkle_root,
    chunk_index_path,
    receipt_path,
    receipt,
    transparency_log_path: transparency.log_path,
    transparency_entry_hash: transparency.entry_hash,
  };
}
