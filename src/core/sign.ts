import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export type Keypair = {
  publicKeyPem: string;
  privateKeyPem: string;
};

export async function loadOrCreateEd25519Keypair(dir: string): Promise<Keypair> {
  await fs.mkdir(dir, { recursive: true });
  const pubPath = path.join(dir, "ed25519_public.pem");
  const privPath = path.join(dir, "ed25519_private.pem");

  try {
    const [publicKeyPem, privateKeyPem] = await Promise.all([
      fs.readFile(pubPath, "utf8"),
      fs.readFile(privPath, "utf8"),
    ]);
    return { publicKeyPem, privateKeyPem };
  } catch {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    await Promise.all([
      fs.writeFile(pubPath, publicKeyPem, "utf8"),
      fs.writeFile(privPath, privateKeyPem, "utf8"),
    ]);
    return { publicKeyPem, privateKeyPem };
  }
}

export function sha512Hex(input: Buffer | string) {
  return crypto.createHash("sha512").update(input).digest("hex");
}

export function signEd25519(privateKeyPem: string, message: Buffer) {
  return crypto.sign(null, message, privateKeyPem).toString("base64");
}

export function verifyEd25519(publicKeyPem: string, message: Buffer, signatureB64: string) {
  return crypto.verify(null, message, publicKeyPem, Buffer.from(signatureB64, "base64"));
}
