import fs from "node:fs/promises";
import crypto from "node:crypto";
import { verifyEd25519, sha512Hex } from "./sign.js";
import { merkleRootFromLeafHex } from "./merkle.js";
import fsSync from "node:fs";

function leafHash(chunk: Buffer) {
  return crypto.createHash("blake2b512").update(chunk).digest("hex");
}

export async function verifyBundle(opts: { bundlePath: string; filePath: string }) {
  const raw = await fs.readFile(opts.bundlePath, "utf8");
  const a: any = JSON.parse(raw);

  const claims = a.claims ?? {};
  const merkle = claims.merkle ?? {};
  const expectedFile = claims.file_digests ?? {};
  const sig = a.signature ?? {};

  const chunkSize = Number(merkle.chunk_size);
  if (!Number.isFinite(chunkSize) || chunkSize <= 0) throw new Error("Invalid chunk_size in bundle");

  // Recompute file digests + leaf digests (streaming)
  const fileBlake2b = crypto.createHash("blake2b512");
  const fileSha512 = crypto.createHash("sha512");

  let buf = Buffer.alloc(0);
  const leafHexes: string[] = [];
  let bytes = 0;

  await new Promise<void>((resolve, reject) => {
    const rs = fsSync.createReadStream(opts.filePath, { highWaterMark: 1024 * 1024 });

    rs.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      fileBlake2b.update(chunk);
      fileSha512.update(chunk);

      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= chunkSize) {
        const out = buf.subarray(0, chunkSize);
        buf = buf.subarray(chunkSize);
        leafHexes.push(leafHash(out));
      }
    });

    rs.on("error", reject);
    rs.on("end", () => resolve());
  });

  if (buf.length > 0) {
    leafHexes.push(leafHash(buf));
    buf = Buffer.alloc(0);
  }

  const actualFile = {
    blake2b_512: fileBlake2b.digest("hex"),
    sha512: fileSha512.digest("hex"),
  };

  const merkleRes = merkleRootFromLeafHex(leafHexes);

  // Check signature
  const signedPayload = claims;
  const signed_message_sha512 = sha512Hex(JSON.stringify(signedPayload));

  const sigOk =
    sig.algorithm === "ed25519" &&
    typeof sig.public_key_pem === "string" &&
    typeof sig.signature_b64 === "string" &&
    verifyEd25519(sig.public_key_pem, Buffer.from(JSON.stringify(signedPayload)), sig.signature_b64);

  const checks = {
    file_blake2b_match: actualFile.blake2b_512 === expectedFile.blake2b_512,
    file_sha512_match: actualFile.sha512 === expectedFile.sha512,
    merkle_root_match: merkleRes.root_hex === merkle.root,
    leaf_count_match: merkleRes.leaf_count === merkle.leaf_count,
    signed_message_sha512_match: signed_message_sha512 === sig.signed_message_sha512,
    signature_valid: sigOk,
  };

  const ok = Object.values(checks).every(Boolean);

  return {
    ok,
    bytes,
    expected: { file_digests: expectedFile, merkle },
    actual: { file_digests: actualFile, merkle_root: merkleRes.root_hex, leaf_count: merkleRes.leaf_count },
    checks,
  };
}
