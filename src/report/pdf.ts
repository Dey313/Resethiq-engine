import fs from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";

type Attestation = any;

function line(doc: PDFKit.PDFDocument, yPad = 10) {
  doc.moveDown(0.4);
  const x1 = doc.page.margins.left;
  const x2 = doc.page.width - doc.page.margins.right;
  const y = doc.y + yPad;
  doc.moveTo(x1, y).lineTo(x2, y).strokeOpacity(0.15).stroke();
  doc.strokeOpacity(1);
  doc.moveDown(0.8);
}

function kv(doc: PDFKit.PDFDocument, k: string, v: string) {
  doc.font("Helvetica-Bold").text(k, { continued: true });
  doc.font("Helvetica").text(` ${v}`);
}

function mono(doc: PDFKit.PDFDocument, text: string) {
  doc.font("Courier").fontSize(9).text(text, { lineBreak: true });
  doc.font("Helvetica").fontSize(11);
}

export async function renderAttestationPDF(opts: {
  attestationPath: string;
  pdfPath: string;
  brand?: { name?: string; tagline?: string };
}) {
  const raw = fs.readFileSync(opts.attestationPath, "utf8");
  const a: Attestation = JSON.parse(raw);

  const brandName = opts.brand?.name ?? "Resethiq™";
  const tagline = opts.brand?.tagline ?? "Evidence-grade Data Integrity & Reproducibility";

  const doc = new PDFDocument({
    size: "A4",
    margins: { top: 54, bottom: 54, left: 54, right: 54 },
    info: {
      Title: "Integrity Attestation Report",
      Author: brandName,
      Subject: "Cryptographic integrity attestation",
    },
  });

  await fs.promises.mkdir(path.dirname(opts.pdfPath), { recursive: true });
  const stream = fs.createWriteStream(opts.pdfPath);
  doc.pipe(stream);

  // Header
  doc.font("Helvetica-Bold").fontSize(20).text("Integrity Attestation Report", { align: "left" });
  doc.moveDown(0.2);
  doc.font("Helvetica").fontSize(11).fillOpacity(0.85).text(`${brandName} • ${tagline}`);
  doc.fillOpacity(1);
  doc.moveDown(0.8);
  line(doc, 4);

  // Executive summary
  doc.font("Helvetica-Bold").fontSize(13).text("Executive Summary");
  doc.moveDown(0.4);

  const manifest = a.manifest ?? {};
  const subject = manifest.subject ?? {};
  const env = manifest.environment ?? {};
  const run = manifest.run ?? {};
  const engine = manifest.engine ?? {};

  // Moved up so merkle can be referenced in appendix safely
  const claims = a.claims ?? {};
  const fileDigests = claims.file_digests ?? {};
  const merkle = claims.merkle ?? {};

  kv(doc, "Dataset / Artifact:", subject.filename ?? "—");
  kv(doc, "Bytes:", String(subject.bytes ?? "—"));
  kv(doc, "Run ID:", run.run_id ?? "—");
  kv(doc, "Created:", run.created_at ?? "—");
  kv(doc, "Engine:", `${engine.name ?? "—"} v${engine.version ?? "—"}`);
  kv(doc, "Runtime:", `${env.node ?? "—"} • ${env.platform ?? "—"} • ${env.arch ?? "—"}`);

  doc.moveDown(0.6);
  doc.font("Helvetica").fontSize(11).fillOpacity(0.9).text(
    "This report provides cryptographic and reproducible evidence that the submitted artifact matches the fingerprints and Merkle commitment recorded in the attestation bundle. The bundle is signed with Ed25519 to enable independent verification."
  );
  doc.fillOpacity(1);
  line(doc, 6);

  // Merkle Proof Appendix (sampled)
  const proofs = a.proofs ?? {};
  const sampled = Array.isArray(proofs.sampled) ? proofs.sampled : [];

  doc.font("Helvetica-Bold").fontSize(13).text("Appendix: Sample Merkle Inclusion Proofs");
  doc.moveDown(0.4);

  doc.font("Helvetica").fontSize(11).fillOpacity(0.9).text(
    "Below are sampled inclusion proofs for selected chunks. Each proof contains the leaf hash and the sibling path required to recompute the Merkle root."
  );
  doc.fillOpacity(1);
  doc.moveDown(0.4);

  kv(doc, "Proof Type:", proofs.type ?? "—");
  kv(doc, "Merkle Root:", "");
  mono(doc, String(proofs.merkle_root ?? merkle.root ?? "—"));
  kv(doc, "Algorithm:", String(proofs.algorithm ?? merkle.algorithm ?? "—"));
  doc.moveDown(0.4);

  const show = sampled.slice(0, 5);
  if (show.length === 0) {
    doc.font("Helvetica").text("No proofs found in attestation bundle.");
  } else {
    for (const p of show) {
      doc.font("Helvetica-Bold").text(`Proof • Leaf index ${p.index} • verifies=${String(p.verifies)}`);
      doc.font("Helvetica").text("leaf_hex:");
      mono(doc, String(p.leaf_hex ?? "—"));

      doc.font("Helvetica").text("siblings_hex (bottom→top):");
      const sibs: string[] = Array.isArray(p.siblings_hex) ? p.siblings_hex : [];
      mono(doc, sibs.slice(0, 12).join("\n") + (sibs.length > 12 ? "\n… (truncated)" : ""));
      doc.moveDown(0.6);
    }
  }

  line(doc, 6);

  // Canonicalization
  doc.font("Helvetica-Bold").fontSize(13).text("Canonicalization & Determinism");
  doc.moveDown(0.4);
  const canon = a.canonicalization ?? {};
  kv(doc, "Canonicalization Spec:", canon.spec_id ?? "—");
  doc.moveDown(0.2);
  doc.font("Helvetica").fontSize(11).fillOpacity(0.9).text(canon.description ?? "—");
  doc.fillOpacity(1);
  line(doc, 6);

  // Cryptographic fingerprints
  doc.font("Helvetica-Bold").fontSize(13).text("Cryptographic Fingerprints");
  doc.moveDown(0.4);

  kv(doc, "File Digest (BLAKE2b-512):", "");
  mono(doc, fileDigests.blake2b_512 ?? "—");

  kv(doc, "File Digest (SHA-512):", "");
  mono(doc, fileDigests.sha512 ?? "—");

  kv(doc, "Merkle Commitment:", "");
  kv(doc, " • Algorithm:", merkle.algorithm ?? "—");
  kv(doc, " • Chunk size:", String(merkle.chunk_size ?? "—"));
  kv(doc, " • Leaf count:", String(merkle.leaf_count ?? "—"));
  kv(doc, " • Root:", "");
  mono(doc, merkle.root ?? "—");

  line(doc, 6);

  // Signature
  doc.font("Helvetica-Bold").fontSize(13).text("Signature & Verification Material");
  doc.moveDown(0.4);
  const sig = a.signature ?? {};

  kv(doc, "Signature Algorithm:", sig.algorithm ?? "—");
  kv(doc, "Signed Message Digest (SHA-512):", "");
  mono(doc, sig.signed_message_sha512 ?? "—");

  kv(doc, "Signature (base64):", "");
  mono(doc, sig.signature_b64 ?? "—");

  kv(doc, "Public Key (PEM):", "");
  mono(doc, sig.public_key_pem ?? "—");

  line(doc, 6);

  // How to verify
  doc.font("Helvetica-Bold").fontSize(13).text("How to Verify (Independent)");
  doc.moveDown(0.4);
  doc.font("Helvetica").fontSize(11).fillOpacity(0.9).text(
    "To independently verify this report, recompute the file digests and Merkle root using the stated chunk size, then validate the Ed25519 signature over the signed payload contained in the attestation JSON."
  );
  doc.fillOpacity(1);
  doc.moveDown(0.4);
  doc.font("Helvetica-Bold").text("Local verification command (engine CLI):");
  doc.font("Helvetica");
  mono(doc, `resethiq verify --bundle out/attestation.json --file ${subject.filename ?? "<file>"}`);

  // Footer
  doc.moveDown(1.2);
  doc.font("Helvetica").fontSize(9).fillOpacity(0.6).text(
    "Generated by Resethiq Integrity Engine. This document is an evidence artifact; cryptographic verification is the source of truth.",
    { align: "left" }
  );
  doc.fillOpacity(1);

  doc.end();

  await new Promise<void>((resolve, reject) => {
    stream.on("finish", () => resolve());
    stream.on("error", reject);
  });
}
