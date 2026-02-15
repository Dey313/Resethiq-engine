import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import multer, { type StorageEngine } from "multer";
import rateLimit from "express-rate-limit";

// ✅ TEMP: we will point this to the real exported function in Step 4
import * as RunAll from "../integrity/pipeline/run_all";

const app = express();

// ===== Config =====
const BASE_DIR = process.env.RESETHIQ_BASEDIR ?? path.resolve(".resethiq");
const UPLOAD_DIR = path.join(BASE_DIR, "uploads");
const RUNS_DIR = path.join(BASE_DIR, "runs");

const API_KEY = process.env.RESETHIQ_API_KEY ?? "";
const CORS_ORIGIN = process.env.RESETHIQ_CORS_ORIGIN ?? "https://demo-resethiq.tech";

// ===== Middleware =====
app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json({ limit: "2mb" }));

app.use(
  rateLimit({
    windowMs: 60_000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

function requireKey(req: Request, res: Response, next: NextFunction) {
  if (!API_KEY) return next(); // demo-only fallback (set API key in VPS)
  const k = req.header("x-api-key");
  if (k && k === API_KEY) return next();
  return res.status(401).json({ ok: false, error: "Unauthorized" });
}

app.get("/health", (_req: Request, res: Response) => res.json({ ok: true }));

const storage: StorageEngine = multer.diskStorage({
  destination: async (_req, _file, cb) => {
    try {
      await fs.mkdir(UPLOAD_DIR, { recursive: true });
      cb(null, UPLOAD_DIR);
    } catch (e) {
      cb(e as Error, UPLOAD_DIR);
    }
  },
  filename: (_req, file, cb) => {
    const id = crypto.randomUUID();
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    cb(null, `${id}__${safe}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 120 * 1024 * 1024 }, // 120MB
});

app.post("/v1/upload", requireKey, upload.single("file"), async (req: Request, res: Response) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: "No file uploaded" });

    const server_path = req.file.path;
    const file_id = path.basename(server_path);

    return res.json({ ok: true, file_id, server_path });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message ?? String(e) });
  }
});

app.post("/v1/run", requireKey, async (req: Request, res: Response) => {
  try {
    await fs.mkdir(RUNS_DIR, { recursive: true });

    const body = (req.body ?? {}) as { file_id?: string; chunkRows?: number; proofs?: number };
    const file_id = body.file_id;
    const chunkRows = body.chunkRows ?? 5000;
    const proofs = body.proofs ?? 5;

    if (!file_id) return res.status(400).json({ ok: false, error: "file_id required" });

    const filePath = path.join(UPLOAD_DIR, file_id);
    await fs.stat(filePath);

    // ===== IMPORTANT =====
    // Your run_all.ts exports some runner. We'll resolve the exact name next.
    // For now we try common names safely.
    const runner =
      (RunAll as any).runFullPipeline ??
      (RunAll as any).runAll ??
      (RunAll as any).runAllEngines ??
      (RunAll as any).runIntegrityPipeline ??
      (RunAll as any).runPipeline;

    if (typeof runner !== "function") {
      return res.status(500).json({
        ok: false,
        error:
          "Could not find a pipeline runner export in src/integrity/pipeline/run_all.ts. Export a function like runFullPipeline({filePath, baseDir, chunkRows, proofs}).",
      });
    }

    const result = await runner({ filePath, baseDir: BASE_DIR, chunkRows, proofs });

    const run_id: string = result.run_id ?? result.runId ?? result?.run?.run_id;
    if (!run_id) {
      return res.status(500).json({ ok: false, error: "Pipeline did not return run_id" });
    }

    return res.json({
      ok: true,
      run_id,
      pdf_url: `/v1/run/${run_id}/report`,
      bundle_url: `/v1/run/${run_id}`,
      outDir: result.outDir ?? path.join(BASE_DIR, "runs", run_id),
    });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message ?? String(e) });
  }
});

app.get("/v1/run/:id", requireKey, async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const bundle = path.join(RUNS_DIR, id, "e9.bundle.json");
  try {
    const raw = await fs.readFile(bundle, "utf8");
    res.setHeader("content-type", "application/json");
    return res.send(raw);
  } catch {
    return res.status(404).json({ ok: false, error: "Not found" });
  }
});

app.get("/v1/run/:id/report", requireKey, async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const pdf = path.join(RUNS_DIR, id, "verdict_report.pdf");
  try {
    await fs.stat(pdf);
    return res.sendFile(path.resolve(pdf));
  } catch {
    return res.status(404).json({ ok: false, error: "Not found" });
  }
});

const PORT = Number(process.env.PORT ?? 4000);
app.listen(PORT, async () => {
  await fs.mkdir(BASE_DIR, { recursive: true });
  console.log(`Resethiq Demo API listening on :${PORT}`);
});
