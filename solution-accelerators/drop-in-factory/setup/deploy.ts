/**
 * `npm run deploy`: deploy Foreman to Cursor hosting from the pushed branch
 * this folder is on, and record which release came from which source.
 *
 *   npm run deploy                      # origin, current branch
 *   npm run deploy -- --repo https://github.com/your-org/your-repo --ref main
 *   npm run deploy -- --dry-run         # print the bdk request, change nothing
 *
 * BDK builds from a pushed ref of a repository the team's Cursor GitHub App
 * can read, and `deployment get` does not say which commit it built. So this
 * refuses to deploy unless the folder is committed and the remote branch is
 * HEAD, then appends the release id, `repo@sha` and a digest of the folder's
 * files to `setup/verdicts/deploys.jsonl`. `npm run doctor` with SA_VERIFY_HOSTED=1
 * checks the running release against that record.
 */

import "../foreman/bot/lib/config/dotenv.ts";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pathsEnv, shellEnv, verifyEnv } from "../foreman/bot/lib/config/env.ts";
import { loadFactory } from "../foreman/bot/lib/config/load.ts";
import { appendDeploy, bdk, deployment, deploymentFrom, jsonFrom } from "./lib/doctor/deployed.ts";
import { currentBranch, deployTarget, dirtyFiles, folderPrefix, headSha, originUrl, remoteSha, sourceDigest } from "./lib/doctor/source.ts";

const factoryDir = fileURLToPath(new URL("..", import.meta.url));
const verify = verifyEnv();
const argv = process.argv.slice(2);
const flag = (name: string): string | null => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? null : (argv[i + 1] ?? "");
};
const dryRun = argv.includes("--dry-run");

const { repos } = loadFactory(resolve(factoryDir, pathsEnv().factoryConfig));
const remote = flag("repo") ?? "origin";
const { repo, agentPath, eventRepos } = deployTarget(
  { remoteUrl: flag("repo") ?? (await originUrl(factoryDir)), prefix: await folderPrefix(factoryDir) },
  repos.map((r) => r.repo),
);
const ref = flag("ref") ?? (await currentBranch(factoryDir));

const dirty = await dirtyFiles(factoryDir);
if (dirty.length > 0) fail(`commit or stash these first, since BDK builds from the pushed branch:\n${dirty.join("\n")}`);
const head = await headSha(factoryDir);
const pushed = await remoteSha(factoryDir, remote, ref);
if (pushed === null) fail(`${repo} has no branch ${ref}. Push it first: git push origin ${ref}`);
if (pushed !== head) fail(`${repo} ${ref} is ${pushed}, and HEAD is ${head}. Push HEAD to ${ref} first, so BDK builds what you have here`);

const args = [
  "deploy", "--dir", ".", "--repo", repo, "--ref", ref, "--path", agentPath,
  ...eventRepos.flatMap((r) => ["--cursor-events-repo", r]),
  "--json", ...(dryRun ? ["--dry-run"] : []),
];
console.log(`deploying ${verify.deploymentSlug} from ${repo}@${head.slice(0, 7)} (${ref}, ${agentPath})`);
const result = await bdk(args, resolve(factoryDir, "foreman"), shellEnv());
process.stdout.write(result.stdout);
if (result.code !== 0) fail(`bdk deploy exited ${result.code}: ${result.stderr.trim().split("\n").slice(-4).join(" ")}`);
if (dryRun) process.exit(0);

let deployed = deploymentFrom(jsonFrom(result.stdout), "bdk deploy printed no JSON");
if (deployed.releaseId === null) deployed = await deployment(verify.deploymentSlug, resolve(factoryDir, "foreman"), shellEnv());
if (deployed.releaseId === null) fail(`bdk deploy finished but reported no release id: ${deployed.error ?? result.stdout.slice(0, 300)}`);
const record = {
  at: new Date().toISOString(),
  slug: verify.deploymentSlug,
  releaseId: deployed.releaseId,
  teamId: deployed.teamId,
  repo,
  ref,
  sha: head,
  path: agentPath,
  digest: await sourceDigest(factoryDir),
};
appendDeploy(resolve(factoryDir, verify.deploysPath), record);
console.log(`recorded release ${record.releaseId} in ${verify.deploysPath}; commit it so the doctor and the next verifier can see it`);

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
