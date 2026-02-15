#!/usr/bin/env node
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { merkleRootFromLeafHex, merkleProof, verifyProof } from "./core/merkle.js";
import { loadOrCreateEd25519Keypair, sha512Hex, signEd25519 } from "./core/sign.js";
import { verifyBundle } from "./core/verify.js";
import { renderAttestationPDF } from "./report/pdf.js";

function usage(): never {
  console.error("Usage:");
  console.error("  resethiq hash   <file> [--chunk <bytes>]");
  console.error("  resethiq attest <file> [--chunk <bytes>] [--out <dir>] [--keys <dir>]");
  console.error("  resethiq verify --bundle <attestation.json> --file <file>");
  process.exit(1);
}

function getFlag(args: string[], name: string, def?: string) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
}

async function streamDigestsAndLeaves(filePath: string, chunkSize: number) {
  const stat = await fsp.stat(filePath);
  if (!stat.isFile()) throw new Error("Input is not a file");

  const fileBlake2b = crypto.createHash("blake2b512");
  const fileSha512 = crypto.createHash("sha512");

  function leafHash(chunk: Buffer) {
    return crypto.createHash("blake2b512").update(chunk).digest("hex");
  }

  let bytes = 0;
  let buf = Buffer.alloc(0);
  let chunks = 0;
  const leafHexes: string[] = [];

  await new Promise<void>((resolve, reject) => {
    const rs = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 });

    rs.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      fileBlake2b.update(chunk);
      fileSha512.update(chunk);

      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= chunkSize) {
        const out = buf.subarray(0, chunkSize);
        buf = buf.subarray(chunkSize);
        leafHexes.push(leafHash(out));
        chunks++;
      }
    });

    rs.on("error", reject);
    rs.on("end", () => resolve());
  });

  if (buf.length > 0) {
    leafHexes.push(leafHash(buf));
    chunks++;
    buf = Buffer.alloc(0);
  }

  const merkle = merkleRootFromLeafHex(leafHexes);

  return {
    bytes,
    chunks_count: chunks,
    leaf_hexes: leafHexes,
    file_digests: {
      blake2b_512: fileBlake2b.digest("hex"),
      sha512: fileSha512.digest("hex"),
    },
    merkle: {
      algorithm: "blake2b512",
      root: merkle.root_hex,
      leaf_count: merkle.leaf_count,
      chunk_size: chunkSize,
    },
  };
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd) usage();

  if (cmd === "verify") {
    const bundlePath = getFlag(args, "--bundle");
    const filePath = getFlag(args, "--file");
    if (!bundlePath || !filePath) usage();

    const res = await verifyBundle({ bundlePath, filePath });
    console.log(JSON.stringify(res, null, 2));
    process.exit(res.ok ? 0 : 3);
  }

  const filePath = args[1];
  if (!filePath) usage();

  const chunkSize = Number(getFlag(args, "--chunk", String(4 * 1024 * 1024)));
  if (!Number.isFinite(chunkSize) || chunkSize <= 0) {
    console.error("Invalid --chunk value");
    process.exit(1);
  }

  if (cmd === "hash") {
    const r = await streamDigestsAndLeaves(filePath, chunkSize);
    console.log(JSON.stringify({ file: filePath, ...r }, null, 2));
    return;
  }

  if (cmd === "attest") {
    const outDir = getFlag(args, "--out", "out")!;
    const keyDir = getFlag(args, "--keys", "keys")!;
    await fsp.mkdir(outDir, { recursive: true });

    const stat = await fsp.stat(filePath);
    const core = await streamDigestsAndLeaves(filePath, chunkSize);
    const leafCount = core.leaf_hexes.length;

// Deterministic sample indices across the file
const sampleIndices = Array.from(new Set([
  0,
  Math.floor(leafCount / 4),
  Math.floor(leafCount / 2),
  Math.floor((3 * leafCount) / 4),
  Math.max(0, leafCount - 1),
].filter((i) => i >= 0 && i < leafCount)));

const sampledProofs = sampleIndices.map((i) => {
  const p = merkleProof(core.leaf_hexes, i);
  return {
    index: p.index,
    leaf_hex: p.leaf_hex,
    siblings_hex: p.siblings_hex,
    verifies: verifyProof(core.merkle.root, p),
  };
});

    const manifest = {
      schema: "resethiq.manifest.v1",
      engine: { name: "Resethiq Integrity Engine", version: "0.1.0" },
      run: {
        run_id: crypto.randomUUID(),
        created_at: new Date().toISOString(),
      },
      subject: {
        filename: path.basename(filePath),
        bytes: stat.size,
      },
      environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
      },
    };

    const manifest_sha512 = sha512Hex(JSON.stringify(manifest));

    const signedPayload = {
      schema: "resethiq.signed_payload.v1",
      manifest_sha512,
      file_digests: core.file_digests,
      merkle: core.merkle,
    };

    const signed_message_sha512 = sha512Hex(JSON.stringify(signedPayload));

    const kp = await loadOrCreateEd25519Keypair(keyDir);
    const signature_b64 = signEd25519(
      kp.privateKeyPem,
      Buffer.from(JSON.stringify(signedPayload))
    );

    const attestation = {
  schema: "resethiq.attestation.v1",
  manifest,
  canonicalization: {
    spec_id: "cdr-stream-v1",
    description:
      "Deterministic fixed-size chunking over byte-stream; schema-aware canonicalization comes in v2.",
  },

  claims: signedPayload,

  proofs: {
    type: "merkle_inclusion_v1",
    merkle_root: core.merkle.root,
    algorithm: "blake2b512",
    sampled: sampledProofs
  },

  signature: {
    algorithm: "ed25519",
    public_key_pem: kp.publicKeyPem,
    signed_message_sha512,
    signature_b64,
  },
};
    const outPath = path.join(outDir, "attestation.json");
    await fsp.writeFile(outPath, JSON.stringify(attestation, null, 2), "utf8");

    const pdfPath = path.join(outDir, "report.pdf");
    await renderAttestationPDF({
      attestationPath: outPath,
      pdfPath,
      brand: { name: "Resethiq™", tagline: "Integrity Infrastructure for AI & Regulated Data" }
    });

    console.log(
      JSON.stringify(
        {
          ok: true,
          out: outPath,
          file: filePath,
          merkle_root: core.merkle.root,
          signed_message_sha512,
        },
        null,
        2
      )
    );
    return;
  }

  usage();
}

main().catch((e) => {
  console.error("Error:", e?.message ?? e);
  process.exit(2);
});
