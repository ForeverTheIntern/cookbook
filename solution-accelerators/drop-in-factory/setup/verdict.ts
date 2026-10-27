/**
 * `npm run verdict`: append or show a row in the SHA-keyed ledger, `setup/verdicts/ledger.jsonl`.
 *
 *   npm run verdict -- append --pr 37 --verdict live-verified --verifier "agent, model" --evidence "media/…" --note "..."
 *   npm run verdict -- show --pr 37
 *   npm run verdict -- reset          # empty the ledger and deploy records of a fresh copy
 *
 * `--sha` defaults to the newest commit that changed this folder outside
 * `setup/verdicts/`, so committing the ledger does not void the row it records.
 * `--deployed` and `--team` default to the last `npm run deploy` record when
 * the verdict is `live-verified`. A new SHA voids older rows for that pull
 * request. `show` exits 1 when the open row is for a different SHA.
 */

import "../foreman/bot/lib/config/dotenv.ts";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyEnv } from "../foreman/bot/lib/config/env.ts";
import { lastDeploy, readDeploys } from "./lib/doctor/deployed.ts";
import { appendRow, currentRow, isVerdict, readLedger, renderMarkdown, VERDICTS, writeLedger, type VerdictRow } from "./lib/doctor/ledger.ts";
import { codeSha } from "./lib/doctor/source.ts";

const factoryDir = fileURLToPath(new URL("..", import.meta.url));
const verify = verifyEnv();
const ledgerPath = resolve(factoryDir, verify.ledgerPath);
const [command, ...rest] = process.argv.slice(2);
const args = flags(rest);

if (command === "append") {
  const pr = required(args, "pr");
  const sha = args.sha || (await codeSha(factoryDir));
  const verdict = required(args, "verdict");
  if (!isVerdict(verdict)) {
    console.error(`verdict must be one of ${VERDICTS.join(", ")}. It is ${verdict}.`);
    process.exit(2);
  }
  const deploy = verdict === "live-verified" ? lastDeploy(readDeploys(resolve(factoryDir, verify.deploysPath)), verify.deploymentSlug) : null;
  const next: Omit<VerdictRow, "void" | "voidedBy"> = {
    pr,
    sha,
    verdict,
    at: new Date().toISOString(),
    note: args.note ?? "",
    deployed: args.deployed ?? (deploy === null ? "" : `release ${deploy.releaseId} (${deploy.repo}@${deploy.sha.slice(0, 7)})`),
    teamId: args.team ?? deploy?.teamId ?? "",
    verifier: args.verifier ?? "",
    evidence: args.evidence ?? "",
  };
  const rows = appendRow(readLedger(ledgerPath), next);
  writeLedger(ledgerPath, rows);
  console.log(renderMarkdown(rows.filter((row) => row.pr === pr)));
  process.exit(0);
}

if (command === "show") {
  const pr = required(args, "pr");
  const sha = args.sha || (await codeSha(factoryDir));
  const rows = readLedger(ledgerPath);
  const row = currentRow(rows, pr, sha);
  if (row === null) {
    const open = [...rows].reverse().find((item) => item.pr === pr && !item.void);
    console.error(open === undefined ? `no open verdict for PR ${pr}` : `void: the open verdict for PR ${pr} is ${open.sha}, and this head is ${sha}`);
    process.exit(1);
  }
  console.log(`${row.verdict} ${row.sha} ${row.note}`.trim());
  process.exit(0);
}

if (command === "reset") {
  mkdirSync(dirname(ledgerPath), { recursive: true });
  writeFileSync(ledgerPath, "");
  for (const path of [ledgerPath.replace(/\.jsonl$/, ".md"), resolve(factoryDir, verify.deploysPath)]) rmSync(path, { force: true });
  console.log("verdict: ledger and deploy records emptied");
  process.exit(0);
}

console.error("Usage: npm run verdict -- append|show|reset --pr <n> [--sha <head>] [--verdict <name>] [--verifier <who>] [--evidence <paths>] [--deployed <release>] [--team <id>] [--note <text>]");
process.exit(2);

function flags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) out[key] = "";
    else {
      out[key] = value;
      i += 1;
    }
  }
  return out;
}

function required(args: Record<string, string>, name: string): string {
  const value = args[name] ?? "";
  if (value === "") {
    console.error(`--${name} is required`);
    process.exit(2);
  }
  return value;
}
