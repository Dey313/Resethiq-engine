import { runAllEngines } from "./run_all.js";

function usage() {
  console.log(`
resethiq integrity pipeline

Usage:
  node dist/integrity/pipeline/cli.js run --file <path.csv>
`);
}

function getArg(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  if (i === -1) return null;
  return process.argv[i + 1] ?? null;
}

async function main() {
  const cmd = process.argv[2];
  if (!cmd || cmd !== "run") {
    usage();
    process.exit(1);
  }

  const file = getArg("--file");
  if (!file) {
    console.error("Missing --file");
    process.exit(1);
  }

  const res = await runAllEngines({
    input_csv_path: file,
    brand: { name: "Resethiq™", tagline: "Evidence-grade Data Integrity & Reproducibility" },
  });

  console.log("OK");
  console.log(res);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
