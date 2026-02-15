import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createReceipt, IntegrityReceipt } from "../kernel/receipt";
import { appendTransparencyLog } from "../kernel/transparencyLog";

function nowISO() { return new Date().toISOString(); }

type Severity = "LOW" | "MED" | "HIGH" | "CRITICAL";

function deriveSeverity(args: {
  replayVerdict?: string | null;
  proofsAllValid: boolean;
  policyRisk?: string;
  piiHits?: number;
}): Severity {
  if (args.replayVerdict === "MISMATCH") return "CRITICAL";
  if (!args.proofsAllValid) return "CRITICAL";

  const pii = args.piiHits ?? 0;
  const pr = args.policyRisk ?? "LOW";

  if (pr === "HIGH" && pii > 0) return "HIGH";
  if (pr === "MED") return "MED";
  return "LOW";
}

export async function runEngine7Trust(args: {
  run_id: string;
  baseDir: string;
  outDir?: string;

  e3_manifest_path: string;
  e3_verdict_path?: string | null;
  e4_contamination_path: string;
  e5_policy_path: string;
  e8_proofs_path: string;
}) {
  const outDir = args.outDir ?? path.join(args.baseDir, "runs", args.run_id);
  await fs.mkdir(outDir, { recursive: true });

  const e3v = args.e3_verdict_path ? JSON.parse(await fs.readFile(args.e3_verdict_path, "utf8")) : null;
  const e4 = JSON.parse(await fs.readFile(args.e4_contamination_path, "utf8"));
  const e5 = JSON.parse(await fs.readFile(args.e5_policy_path, "utf8"));
  const e8 = JSON.parse(await fs.readFile(args.e8_proofs_path, "utf8"));

  const reproducibility = e3v ? (e3v.verdict === "MATCH" ? 100 : 40) : 70;
  const merkle_proofs = e8?.all_verified === true ? 100 : 20;
  const contamination = Math.max(0, 100 - Math.round((e4?.stats?.duplicate_ratio_est ?? 0) * 100));
  const policy = e5?.dataset_risk === "HIGH" ? 30 :
                 e5?.dataset_risk === "MED" ? 60 : 95;

  const weighted =
    reproducibility * 0.30 +
    merkle_proofs * 0.20 +
    contamination * 0.20 +
    policy * 0.30;

  const severity = deriveSeverity({
    replayVerdict: e3v?.verdict ?? null,
    proofsAllValid: e8?.all_verified === true,
    policyRisk: e5?.dataset_risk,
    piiHits: e5?.scan?.pii_hits_total ?? 0
  });

  let verdict: "PASS" | "WARN" | "FAIL";
  if (severity === "CRITICAL") verdict = "FAIL";
  else if (severity === "HIGH") verdict = "WARN";
  else if (weighted >= 85) verdict = "PASS";
  else verdict = "WARN";

  const reasoning = `
This dataset was evaluated across reproducibility, cryptographic integrity, contamination risk, and policy exposure.
Severity tier: ${severity}.
Replay verification: ${e3v ? e3v.verdict : "Not performed"}.
Merkle proofs: ${e8?.all_verified ? "Verified" : "Failed"}.
Policy risk: ${e5?.dataset_risk}.
Final verdict derived deterministically from severity tier and weighted integrity score.
  `.trim();

  const result = {
    engine: "e7.trust",
    created_at: nowISO(),
    run_id: args.run_id,
    score: Math.round(weighted),
    verdict,
    severity,
    components: {
      reproducibility,
      merkle_proofs,
      contamination,
      policy
    },
    reasoning
  };

  const trust_path = path.join(outDir, "e7.trust_score.json");
  await fs.writeFile(trust_path, JSON.stringify(result, null, 2), "utf8");

  const receipt = createReceipt({
    engine: "e7.trust",
    run_id: args.run_id,
    created_at: nowISO(),
    inputs: {},
    params: {},
    outputs: { score: result.score, verdict },
    environment: {
      node: process.version,
      platform: os.platform(),
      arch: os.arch(),
      cpus: os.cpus()?.length ?? null,
    },
  });

  const receipt_path = path.join(outDir, "e7.receipt.json");
  await fs.writeFile(receipt_path, JSON.stringify(receipt, null, 2), "utf8");

  const tl = await appendTransparencyLog({
    baseDir: args.baseDir,
    receipt_hash: receipt.receipt_hash,
    timestampISO: receipt.created_at,
  });

  return {
    trust_path,
    receipt_path,
    receipt,
    transparency_log_path: tl.log_path,
    transparency_entry_hash: tl.entry_hash,
  };
}
