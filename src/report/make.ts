import { renderAttestationPDF } from "./pdf.js";

const attestationPath = process.argv[2] ?? "out/attestation.json";
const pdfPath = process.argv[3] ?? "out/report.pdf";

await renderAttestationPDF({
  attestationPath,
  pdfPath,
  brand: { name: "Resethiq™", tagline: "Integrity Infrastructure for AI & Regulated Data" }
});

console.log(JSON.stringify({ ok: true, attestation: attestationPath, pdf: pdfPath }, null, 2));
