import Fastify from "fastify";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import path from "node:path";
import fs from "node:fs/promises";
import fss from "node:fs";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// --- Config (env) ---
const PORT = Number(process.env.PORT ?? 8080);
const TOKEN = process.env.DEMO_TOKEN ?? ""; // token gate
const BASIC_USER = process.env.BASIC_USER ?? ""; // optional basic auth gate
const BASIC_PASS = process.env.BASIC_PASS ?? "";

const OUT_ROOT = process.env.OUT_ROOT ?? path.join(process.cwd(), "demo_out");
const KEYS_DIR = process.env.KEYS_DIR ?? path.join(process.cwd(), "keys");
const MAX_BYTES = Number(process.env.MAX_BYTES ?? 100 * 1024 * 1024); // 100MB
const CHUNK_SIZE = Number(process.env.CHUNK_SIZE ?? 4 * 1024 * 1024); // 4 MiB

function unauthorized(reply: any) {
  reply
    .code(401)
    .header("WWW-Authenticate", 'Basic realm="Resethiq Demo"')
    .send("Unauthorized");
}

function checkBasicAuth(req: any) {
  if (!BASIC_USER || !BASIC_PASS) return true; // disabled
  const h = req.headers["authorization"];
  if (!h || !String(h).startsWith("Basic ")) return false;
  const raw = Buffer.from(String(h).slice(6), "base64").toString("utf8");
  const [u, p] = raw.split(":");
  return u === BASIC_USER && p === BASIC_PASS;
}

function checkToken(req: any) {
  if (!TOKEN) return true; // disabled
  const t = (req.query as any)?.token ?? req.headers["x-demo-token"];
  return t === TOKEN;
}

async function ensureDir(p: string) {
  await fs.mkdir(p, { recursive: true });
}

function escapeHtml(s: string) {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function pageHome(token: string) {
  const maxMb = Math.round(MAX_BYTES / (1024 * 1024));
  const chunkMiB = Math.round(CHUNK_SIZE / (1024 * 1024));

  return [
    "<!doctype html>",
    "<html>",
    "<head>",
    '  <meta charset="utf-8">',
    "  <title>Resethiq Demo</title>",
    "</head>",
    '<body style="font-family: ui-sans-serif, system-ui; max-width: 980px; margin: 44px auto; line-height: 1.4;">',
    '  <h1 style="margin-bottom:6px;">Resethiq Integrity Demo</h1>',
    '  <div style="opacity:0.85; margin-bottom:16px;">',
    "    <div><b>Pulse</b> runs Engine 1 (Attestation) and produces a signed PDF report + JSON bundle.</div>",
    "    <div style=\"margin-top:6px;\">Engines 2–3 (Canonicalization & Fingerprint) will appear here next.</div>",
    "  </div>",
    '  <form action="/api/attest?token=' + encodeURIComponent(token) + '" method="post" enctype="multipart/form-data" style="padding:16px; border:1px solid #e6e6e6; border-radius:14px;">',
    '    <input type="file" name="file" required />',
    '    <button type="submit" style="margin-left:10px; padding:10px 14px;">Run Pulse</button>',
    "  </form>",
    '  <p style="margin-top:14px; opacity:0.7;">Max upload: ' +
      maxMb +
      "MB • Chunk size: " +
      chunkMiB +
      "MiB</p>",
    "</body>",
    "</html>",
  ].join("\n");
}

function pageResult(opts: {
  token: string;
  runId: string;
  filename: string;
  bytes: number;
  pdfUrl: string;
  jsonUrl: string;
  verifyStdout: string;
}) {
  return [
    "<!doctype html>",
    "<html>",
    "<head>",
    '  <meta charset="utf-8">',
    "  <title>Pulse Result • Resethiq</title>",
    "</head>",
    '<body style="font-family: ui-sans-serif, system-ui; max-width: 980px; margin: 44px auto; line-height: 1.4;">',
    '  <h1 style="margin-bottom:6px;">Pulse complete ✅</h1>',
    '  <div style="opacity:0.85; margin-bottom:16px;">Run ID: <code>' + escapeHtml(opts.runId) + "</code></div>",
    '  <div style="padding:16px; border:1px solid #e6e6e6; border-radius:14px;">',
    "    <div><b>Artifact:</b> " + escapeHtml(opts.filename) + "</div>",
    "    <div><b>Bytes:</b> " + String(opts.bytes) + "</div>",
    '    <div style="margin-top:14px;">',
    '      <a href="' +
      escapeHtml(opts.pdfUrl) +
      '" target="_blank" style="display:inline-block; padding:12px 16px; background:#111; color:#fff; text-decoration:none; border-radius:10px;">Download Report (PDF)</a>',
    '      <a href="' +
      escapeHtml(opts.jsonUrl) +
      '" target="_blank" style="display:inline-block; margin-left:10px; padding:12px 16px; border:1px solid #111; color:#111; text-decoration:none; border-radius:10px;">Download JSON (Attestation)</a>',
    "    </div>",
    "  </div>",
    '  <h2 style="margin-top:26px;">Verification</h2>',
    '  <pre style="background:#f6f6f6; padding:14px; border-radius:14px; overflow:auto;">' +
      escapeHtml(opts.verifyStdout) +
      "</pre>",
    '  <p style="margin-top:18px;"><a href="/?token=' +
      encodeURIComponent(opts.token) +
      '">Run Pulse again</a></p>',
    "</body>",
    "</html>",
  ].join("\n");
}

const app = Fastify({ logger: true });

await ensureDir(OUT_ROOT);

app.register(multipart, { limits: { fileSize: MAX_BYTES } });

// Home
app.get("/", async (req, reply) => {
  if (!checkToken(req)) return reply.code(403).send("Forbidden (bad token)");
  if (!checkBasicAuth(req)) return unauthorized(reply);

  const token = String((req.query as any)?.token ?? "");
  reply.type("text/html").send(pageHome(token));
});

// Attest -> HTML result page
app.post("/api/attest", async (req, reply) => {
  if (!checkToken(req)) return reply.code(403).send("Forbidden (bad token)");
  if (!checkBasicAuth(req)) return unauthorized(reply);

  const file = await (req as any).file();
  if (!file) return reply.code(400).send("No file provided");

  const runId = crypto.randomUUID();
  const runDir = path.join(OUT_ROOT, runId);
  await ensureDir(runDir);

  // Save upload
  const inPath = path.join(runDir, file.filename);
  const ws = fss.createWriteStream(inPath);

  let written = 0;
  await new Promise<void>((resolve, reject) => {
    file.file.on("data", (c: Buffer) => (written += c.length));
    file.file.on("error", reject);
    ws.on("error", reject);
    ws.on("finish", () => resolve());
    file.file.pipe(ws);
  });

  // Run engine -> attestation.json + report.pdf into runDir
  await execFileAsync("npx", [
    "tsx",
    "src/cli.ts",
    "attest",
    inPath,
    "--chunk",
    String(CHUNK_SIZE),
    "--out",
    runDir,
    "--keys",
    KEYS_DIR,
  ]);

  // Verify output
  const verify = await execFileAsync("npx", [
    "tsx",
    "src/cli.ts",
    "verify",
    "--bundle",
    path.join(runDir, "attestation.json"),
    "--file",
    inPath,
  ]);

  const baseUrl = "/out/" + runId;
  const pdfUrl = baseUrl + "/report.pdf";
  const jsonUrl = baseUrl + "/attestation.json";
  const token = String((req.query as any)?.token ?? "");

  reply.type("text/html").send(
    pageResult({
      token,
      runId,
      filename: file.filename,
      bytes: written,
      pdfUrl,
      jsonUrl,
      verifyStdout: verify.stdout || "",
    })
  );
});

// Static artifacts
app.register(fastifyStatic, {
  root: OUT_ROOT,
  prefix: "/out/",
  decorateReply: false,
});

app.listen({ port: PORT, host: "0.0.0.0" });