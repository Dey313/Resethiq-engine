import path from "node:path";
import { randomUUID } from "node:crypto";

import { runEngine2MerkleAttest } from "../engines/e2_merkle.js";
import { runEngine3Repro } from "../engines/e3_repro.js";
import { runEngine4Contamination } from "../engines/e4_contamination.js";
import { runEngine5Policy } from "../engines/e5_policy.js";
import { runEngine6StreamingCheckpoint } from "../engines/e6_streaming.js";
import { runEngine8ProofSampler } from "../engines/e8_proofs.js";
import { runEngine7Trust } from "../engines/e7_trust.js";
import { runEngine9Bundle } from "../engines/e9_bundle.js";

import { renderDetailedVerdictPDF } from "../../report/pdf_detailed.js";

export async function runAllEngines(args: {
  input_csv_path: string;
  brand?: { name?: string; tagline?: string };
}) {
  const baseDir = ".resethiq";
  const run_id = `run_${randomUUID()}`;
  const outDir = path.join(baseDir, "runs", run_id);

  const e2 = await runEngine2MerkleAttest({
    run_id,
    input_csv_path: args.input_csv_path,
    baseDir,
  });

  const e3 = await runEngine3Repro({
    run_id,
    baseDir,
    input_csv_path: args.input_csv_path,
    e2_chunk_index_path: e2.chunk_index_path,
    e2_receipt_hash: e2.receipt.receipt_hash,
  });

  const e4 = await runEngine4Contamination({ run_id, baseDir, input_csv_path: args.input_csv_path });
  const e5 = await runEngine5Policy({ run_id, baseDir, input_csv_path: args.input_csv_path });
  const e6 = await runEngine6StreamingCheckpoint({ run_id, baseDir });
  const e8 = await runEngine8ProofSampler({ run_id, baseDir, e2_chunk_index_path: e2.chunk_index_path });
  const e7 = await runEngine7Trust({
    run_id,
    baseDir,
    e3_manifest_path: e3.manifest_path,
    e4_contamination_path: e4.report_path,
    e5_policy_path: e5.report_path,
    e8_proofs_path: e8.proofs_path,
  });

  const e9 = await runEngine9Bundle({
    run_id,
    baseDir,
    e2_chunk_index_path: e2.chunk_index_path,
    e3_manifest_path: e3.manifest_path,
    e4_path: e4.report_path,
    e5_path: e5.report_path,
    e6_path: e6.checkpoint_path,
    e7_path: e7.trust_path,
    e8_path: e8.proofs_path,
    receipt_paths: {
      e2: e2.receipt_path,
      e3: e3.receipt_path,
      e4: e4.receipt_path,
      e5: e5.receipt_path,
      e6: e6.receipt_path,
      e7: e7.receipt_path,
      e8: e8.receipt_path,
    },
  });

  const pdf_path = path.join(outDir, "verdict_report.pdf");

  await renderDetailedVerdictPDF({
    bundlePath: e9.bundle_path,
    pdfPath: pdf_path,
    brand: args.brand,
  });

  return { run_id, outDir, bundle_path: e9.bundle_path, pdf_path };
}
