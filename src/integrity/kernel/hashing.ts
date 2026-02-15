import crypto from "node:crypto";

export type HashAlg = "sha256";

/** Hash raw bytes -> Buffer */
export function hashBytes(buf: Buffer, alg: HashAlg = "sha256"): Buffer {
  return crypto.createHash(alg).update(buf).digest();
}

/** Hash raw bytes -> hex string */
export function hashHex(buf: Buffer, alg: HashAlg = "sha256"): string {
  return crypto.createHash(alg).update(buf).digest("hex");
}

/** Deterministic JSON hash using stable stringify */
export function hashJSON(obj: unknown, alg: HashAlg = "sha256"): string {
  const s = stableStringify(obj);
  return hashHex(Buffer.from(s, "utf8"), alg);
}

/** Minimal stable stringify: objects sorted by key; arrays preserved order */
export function stableStringify(x: any): string {
  if (x === null) return "null";
  const t = typeof x;
  if (t === "number" || t === "boolean" || t === "string") return JSON.stringify(x);
  if (Array.isArray(x)) return `[${x.map(stableStringify).join(",")}]`;
  const keys = Object.keys(x).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(x[k])}`).join(",")}}`;
}
