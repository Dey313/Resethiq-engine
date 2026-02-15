import fs from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";

type Bundle = any;

type Brand = {
  name?: string;
  tagline?: string;
};

function safeNum(x: any, d = 0): number {
  const n = Number(x);
  return Number.isFinite(n) ? n : d;
}

function safeStr(x: any, d = "—"): string {
  if (x === null || x === undefined) return d;
  const s = String(x);
  return s.length ? s : d;
}

function setFill(doc: PDFKit.PDFDocument, hex: string, opacity = 1) {
  doc.fillColor(hex);
  doc.fillOpacity(opacity);
}
function setStroke(doc: PDFKit.PDFDocument, hex: string, opacity = 1) {
  doc.strokeColor(hex);
  doc.strokeOpacity(opacity);
}

function hline(doc: PDFKit.PDFDocument, y: number, opacity = 0.18) {
  const x1 = doc.page.margins.left;
  const x2 = doc.page.width - doc.page.margins.right;
  doc.save();
  setStroke(doc, "#FFFFFF", opacity);
  doc.moveTo(x1, y).lineTo(x2, y).stroke();
  doc.restore();
}

function kv(doc: PDFKit.PDFDocument, k: string, v: string) {
  doc.font("Helvetica-Bold").fillColor("#EAEAEA").text(k, { continued: true });
  doc.font("Helvetica").fillColor("#D7D7D7").text(` ${v}`);
}

function mono(doc: PDFKit.PDFDocument, text: string) {
  doc.font("Courier").fontSize(9).fillColor("#D7D7D7").text(text, { lineBreak: true });
  doc.font("Helvetica").fontSize(11);
}

function sectionTitle(doc: PDFKit.PDFDocument, t: string) {
  doc.moveDown(0.2);
  doc.font("Helvetica-Bold").fontSize(13).fillColor("#FFFFFF").text(t);
  doc.moveDown(0.25);
}

function chip(doc: PDFKit.PDFDocument, x: number, y: number, w: number, h: number, label: string, color: string) {
  doc.save();
  setFill(doc, color, 0.18);
  doc.roundedRect(x, y, w, h, 10).fill();
  setStroke(doc, color, 0.85);
  doc.roundedRect(x, y, w, h, 10).stroke();
  doc.font("Helvetica-Bold").fontSize(10).fillColor("#FFFFFF").text(label, x + 10, y + 6, { width: w - 20 });
  doc.restore();
}

function drawStarfield(doc: PDFKit.PDFDocument) {
  // Subtle deterministic-ish starfield (no RNG seed needed; PDF is non-crypto)
  doc.save();
  const w = doc.page.width;
  const h = doc.page.height;
  for (let i = 0; i < 120; i++) {
    const x = (i * 73) % w;
    const y = (i * 131) % h;
    const r = (i % 7) === 0 ? 1.2 : 0.7;
    const op = (i % 11) === 0 ? 0.20 : 0.12;
    setFill(doc, "#FFFFFF", op);
    doc.circle(x, y, r).fill();
  }
  doc.restore();
}

function drawHeader(doc: PDFKit.PDFDocument, brandName: string, tagline: string, verdict: string, score: number) {
  const w = doc.page.width;
  const headerH = 96;

  doc.save();
  // Dark band
  setFill(doc, "#0A0F1F", 1);
  doc.rect(0, 0, w, headerH).fill();

  // Accent line
  setFill(doc, "#7CF7FF", 0.55);
  doc.rect(0, headerH - 3, w, 3).fill();

  // Title
  doc.font("Helvetica-Bold").fontSize(20).fillColor("#FFFFFF").text("Integrity Verdict Report", 54, 22);
  doc.font("Helvetica").fontSize(11).fillColor("#C9D2FF").text(`${brandName} • ${tagline}`, 54, 48);

  // Verdict badge on right
  const badgeW = 190;
  const badgeH = 44;
  const bx = w - 54 - badgeW;
  const by = 26;

  let vc = "#F5C542"; // WARN
  if (verdict === "PASS") vc = "#4CFF9A";
  if (verdict === "FAIL") vc = "#FF4D6D";

  setFill(doc, vc, 0.18);
  doc.roundedRect(bx, by, badgeW, badgeH, 14).fill();
  setStroke(doc, vc, 0.9);
  doc.roundedRect(bx, by, badgeW, badgeH, 14).stroke();

  doc.font("Helvetica-Bold").fontSize(12).fillColor("#FFFFFF").text(`VERDICT: ${verdict}`, bx + 14, by + 10, { width: badgeW - 28 });
  doc.font("Helvetica").fontSize(10).fillColor("#D7D7D7").text(`TRUST: ${score}/100`, bx + 14, by + 26, { width: badgeW - 28 });

  doc.restore();
}

function drawRadar(
  doc: PDFKit.PDFDocument,
  cx: number,
  cy: number,
  radius: number,
  labels: string[],
  values01: number[],
  accent: string
) {
  // Radar with N axes
  const n = labels.length;
  if (n < 3) return;

  doc.save();

  // Grid rings
  for (let r = 0.25; r <= 1.001; r += 0.25) {
    const rr = radius * r;
    const pts: Array<[number, number]> = [];
    for (let i = 0; i < n; i++) {
      const ang = (-Math.PI / 2) + (i * 2 * Math.PI) / n;
      pts.push([cx + rr * Math.cos(ang), cy + rr * Math.sin(ang)]);
    }
    setStroke(doc, "#FFFFFF", 0.12);
    doc.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) doc.lineTo(pts[i][0], pts[i][1]);
    doc.closePath().stroke();
  }

  // Axes + labels
  for (let i = 0; i < n; i++) {
    const ang = (-Math.PI / 2) + (i * 2 * Math.PI) / n;
    const x = cx + radius * Math.cos(ang);
    const y = cy + radius * Math.sin(ang);
    setStroke(doc, "#FFFFFF", 0.16);
    doc.moveTo(cx, cy).lineTo(x, y).stroke();

    const lx = cx + (radius + 14) * Math.cos(ang);
    const ly = cy + (radius + 14) * Math.sin(ang);

    doc.font("Helvetica").fontSize(9).fillColor("#D7D7D7");
    doc.text(labels[i], lx - 30, ly - 5, { width: 60, align: "center" });
  }

  // Polygon for values
  const ptsV: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) {
    const v = Math.max(0, Math.min(1, values01[i] ?? 0));
    const ang = (-Math.PI / 2) + (i * 2 * Math.PI) / n;
    ptsV.push([cx + radius * v * Math.cos(ang), cy + radius * v * Math.sin(ang)]);
  }

  setFill(doc, accent, 0.16);
  doc.moveTo(ptsV[0][0], ptsV[0][1]);
  for (let i = 1; i < ptsV.length; i++) doc.lineTo(ptsV[i][0], ptsV[i][1]);
  doc.closePath().fill();

  setStroke(doc, accent, 0.85);
  doc.moveTo(ptsV[0][0], ptsV[0][1]);
  for (let i = 1; i < ptsV.length; i++) doc.lineTo(ptsV[i][0], ptsV[i][1]);
  doc.closePath().stroke();

  // Value points
  for (const [x, y] of ptsV) {
    setFill(doc, "#FFFFFF", 0.9);
    doc.circle(x, y, 1.6).fill();
  }

  doc.restore();
}

function drawPipelineDiagram(doc: PDFKit.PDFDocument, x: number, y: number, w: number) {
  // Simple horizontal flow: E2→E3→E4→E5→E6→E8→E7→E9
  const steps = ["E2", "E3", "E4", "E5", "E6", "E8", "E7", "E9"];
  const labels = ["Merkle", "Repro", "Contam", "Policy", "Checkpoint", "Proofs", "Trust", "Bundle"];
  const gap = 8;
  const boxW = Math.floor((w - gap * (steps.length - 1)) / steps.length);
  const boxH = 40;

  doc.save();
  for (let i = 0; i < steps.length; i++) {
    const bx = x + i * (boxW + gap);
    const by = y;

    setFill(doc, "#7CF7FF", 0.10);
    doc.roundedRect(bx, by, boxW, boxH, 10).fill();
    setStroke(doc, "#7CF7FF", 0.35);
    doc.roundedRect(bx, by, boxW, boxH, 10).stroke();

    doc.font("Helvetica-Bold").fontSize(11).fillColor("#FFFFFF").text(steps[i], bx, by + 8, { width: boxW, align: "center" });
    doc.font("Helvetica").fontSize(8).fillColor("#D7D7D7").text(labels[i], bx, by + 24, { width: boxW, align: "center" });

    if (i < steps.length - 1) {
      const ax1 = bx + boxW;
      const ay = by + boxH / 2;
      const ax2 = bx + boxW + gap;
      setStroke(doc, "#FFFFFF", 0.18);
      doc.moveTo(ax1, ay).lineTo(ax2, ay).stroke();
      // arrow head
      doc.moveTo(ax2 - 4, ay - 3).lineTo(ax2, ay).lineTo(ax2 - 4, ay + 3).stroke();
    }
  }
  doc.restore();
}

export async function renderDetailedVerdictPDF(opts: {
  bundlePath: string;
  pdfPath: string;
  brand?: Brand;
}) {
  const raw = fs.readFileSync(opts.bundlePath, "utf8");
  const b: Bundle = JSON.parse(raw);

  const brandName = opts.brand?.name ?? "Resethiq™";
  const tagline = opts.brand?.tagline ?? "Evidence-grade Data Integrity & Reproducibility";

  const verdict = safeStr(b.verdict, "—");
  const score = safeNum(b.trust_score, 0);

  const doc = new PDFDocument({
    size: "A4",
    margins: { top: 54, bottom: 54, left: 54, right: 54 },
    info: { Title: "Integrity Verdict Report", Author: brandName, Subject: "Evidence bundle verdict" },
  });

  await fs.promises.mkdir(path.dirname(opts.pdfPath), { recursive: true });
  const stream = fs.createWriteStream(opts.pdfPath);
  doc.pipe(stream);

  // Background starfield
  setFill(doc, "#060A14", 1);
  doc.rect(0, 0, doc.page.width, doc.page.height).fill();
  drawStarfield(doc);

  // Header band
  drawHeader(doc, brandName, tagline, verdict, score);

  // Body starts below header
  doc.y = 120;

  // Pull artifacts
  const e2 = b.artifacts?.e2 ?? {};
  const e3m = b.artifacts?.e3_manifest ?? {};
  const e3v = b.artifacts?.e3_verdict ?? null;
  const e4 = b.artifacts?.e4 ?? {};
  const e5 = b.artifacts?.e5 ?? {};
  const e7 = b.artifacts?.e7 ?? {};
  const e8 = b.artifacts?.e8 ?? {};
  const receipts = b.receipts ?? {};

  // Executive summary block
  sectionTitle(doc, "1) Executive Summary");
  kv(doc, "Run ID:", safeStr(b.run_id));
  kv(doc, "Created:", safeStr(b.created_at));
  kv(doc, "Input file:", safeStr(e3m?.dataset?.input_file));
  kv(doc, "Rows:", safeStr(e2?.rows ?? e3m?.dataset?.rows));
  kv(doc, "Chunk rows:", safeStr(e2?.chunking?.chunk_rows ?? e3m?.dataset?.chunk_rows));
  kv(doc, "Replay:", e3v ? safeStr(e3v.verdict) : "— (no comparison)");
  kv(doc, "Policy risk:", safeStr(e5?.dataset_risk));
  doc.moveDown(0.35);
  kv(doc, "Merkle root:", "");
  mono(doc, safeStr(e2?.merkle_root ?? e3m?.dataset?.merkle_root));
  doc.moveDown(0.2);
  hline(doc, doc.y + 6);

  // Visuals: radar + pipeline
  sectionTitle(doc, "2) Integrity Posture");
  const repro = safeNum(e7?.components?.reproducibility, 0) / 100;
  const proofs = safeNum(e7?.components?.merkle_proofs, 0) / 100;
  const contam = safeNum(e7?.components?.contamination, 0) / 100;
  const policy = safeNum(e7?.components?.policy, 0) / 100;

  const leftX = doc.page.margins.left;
  const rightX = doc.page.width - doc.page.margins.right;
  const midY = doc.y;

  // Radar
  const radarCx = leftX + 150;
  const radarCy = midY + 95;
  drawRadar(
    doc,
    radarCx,
    radarCy,
    72,
    ["Repro", "Proofs", "Contam", "Policy"],
    [repro, proofs, contam, policy],
    "#7CF7FF"
  );

  // Chips
  chip(doc, leftX + 260, midY + 18, 150, 30, `Repro: ${Math.round(repro * 100)}/100`, "#7CF7FF");
  chip(doc, leftX + 260, midY + 56, 150, 30, `Proofs: ${Math.round(proofs * 100)}/100`, "#7CF7FF");
  chip(doc, leftX + 420, midY + 18, 150, 30, `Contam: ${Math.round(contam * 100)}/100`, "#7CF7FF");
  chip(doc, leftX + 420, midY + 56, 150, 30, `Policy: ${Math.round(policy * 100)}/100`, "#7CF7FF");

  doc.y = midY + 150;

  // Pipeline diagram
  doc.font("Helvetica").fontSize(10).fillColor("#D7D7D7").text("Evidence pipeline (chained receipts + transparency log):");
  doc.moveDown(0.4);
  drawPipelineDiagram(doc, leftX, doc.y, rightX - leftX);
  doc.y += 54;

  hline(doc, doc.y + 6);

  // Trust breakdown narrative
  sectionTitle(doc, "3) Trust Score Breakdown (E7)");
  kv(doc, "Score:", `${safeStr(e7?.score)}/100`);
  kv(doc, "Verdict:", safeStr(e7?.verdict));
  doc.moveDown(0.2);
  const expl: string[] = Array.isArray(e7?.explanation) ? e7.explanation : [];
  if (expl.length) {
    doc.font("Helvetica").fontSize(10).fillColor("#D7D7D7").text("Notes:");
    for (const x of expl.slice(0, 8)) doc.text(`• ${x}`);
    doc.font("Helvetica").fontSize(11);
  }
  hline(doc, doc.y + 6);

  // Proofs
  sectionTitle(doc, "4) Merkle Inclusion Proofs (E8)");
  kv(doc, "Algorithm:", safeStr(e8?.algorithm));
  kv(doc, "Merkle root:", "");
  mono(doc, safeStr(e8?.merkle_root));
  doc.moveDown(0.3);

  const sampled = Array.isArray(e8?.sampled) ? e8.sampled : [];
  if (!sampled.length) {
    doc.font("Helvetica").fillColor("#D7D7D7").text("No proofs included.");
  } else {
    const show = sampled.slice(0, 3);
    for (const p of show) {
      doc.font("Helvetica-Bold").fillColor("#FFFFFF").text(
        `Proof • leaf index ${safeStr(p.index)} • verifies=${safeStr(p.verifies)}`
      );
      doc.font("Helvetica").fillColor("#D7D7D7").text("leaf_hex:");
      mono(doc, safeStr(p.leaf_hex));
      doc.font("Helvetica").fillColor("#D7D7D7").text("siblings_hex (bottom→top):");
      const sibs: string[] = Array.isArray(p.siblings_hex) ? p.siblings_hex : [];
      mono(doc, sibs.slice(0, 10).join("\n") + (sibs.length > 10 ? "\n… (truncated)" : ""));
      doc.moveDown(0.35);
    }
  }

  hline(doc, doc.y + 6);

  // Policy & contamination summary
  sectionTitle(doc, "5) Risk Signals (E4, E5)");
  kv(doc, "Duplicate ratio est:", safeStr(e4?.stats?.duplicate_ratio_est));
  kv(doc, "Approx unique rows:", safeStr(e4?.stats?.approx_unique_rows));
  kv(doc, "Dataset policy risk:", safeStr(e5?.dataset_risk));
  kv(doc, "PII hits total:", safeStr(e5?.scan?.pii_hits_total));
  doc.moveDown(0.25);

  const notes: string[] = Array.isArray(e5?.notes) ? e5.notes : [];
  if (notes.length) {
    doc.font("Helvetica").fontSize(10).fillColor("#D7D7D7").text("Policy notes:");
    for (const n of notes.slice(0, 6)) doc.text(`• ${n}`);
    doc.font("Helvetica").fontSize(11);
  }

  hline(doc, doc.y + 6);

  // Evidence integrity (bundle hash + receipt chain)
  sectionTitle(doc, "6) Evidence Integrity (Bundle + Receipt Chain)");
  kv(doc, "Bundle hash:", "");
  mono(doc, safeStr(b.bundle_hash));

  const rkeys = Object.keys(receipts).sort();
  doc.moveDown(0.2);
  doc.font("Helvetica").fontSize(10).fillColor("#D7D7D7").text("Receipt hashes (source-of-truth chain):");
  doc.font("Helvetica").fontSize(11);

  for (const k of rkeys.slice(0, 9)) {
    const r = receipts[k];
    doc.font("Helvetica-Bold").fillColor("#FFFFFF").text(`${k.toUpperCase()} • ${safeStr(r?.engine)}`);
    doc.font("Helvetica").fillColor("#D7D7D7").text("receipt_hash:");
    mono(doc, safeStr(r?.receipt_hash));
    if (r?.prev_receipt_hash) {
      doc.font("Helvetica").fillColor("#D7D7D7").text("prev_receipt_hash:");
      mono(doc, safeStr(r?.prev_receipt_hash));
    }
    doc.moveDown(0.15);
  }

  // Footer
  doc.moveDown(0.8);
  doc.font("Helvetica").fontSize(9).fillColor("#AEB6D6").fillOpacity(0.75).text(
    "Resethiq Integrity Engine — This report is derived from a cryptographically linked evidence bundle. Verify Merkle root + proofs + receipts + transparency log for independent validation.",
    { align: "left" }
  );
  doc.fillOpacity(1);

  doc.end();

  await new Promise<void>((resolve, reject) => {
    stream.on("finish", resolve);
    stream.on("error", reject);
  });
}
