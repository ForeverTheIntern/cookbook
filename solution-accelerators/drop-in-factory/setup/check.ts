/**
 * `npm run check`: copy this folder to a temp directory without its
 * packages, local data or `.env`, then install, typecheck and test there with
 * no credentials. The same check as `ci/isolated-copy.sh`, on any OS.
 */

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), "factory-check-"));
const copy = join(tmp, "accelerator");
const skip = new Set(["node_modules", ".agent-serve", ".data", ".factory", ".next", "data", ".env"]);

try {
  cpSync(root, copy, {
    recursive: true,
    filter: (src) => {
      const rel = relative(root, src);
      if (rel === "") return true;
      if (rel.split(sep).some((part) => skip.has(part))) return false;
      const name = basename(src);
      return !name.startsWith(".env.") || name === ".env.example";
    },
  });
  for (const f of ["README.md", "ARCHITECTURE.md", "docs/security.md", "AGENTS.md", "factory.yaml", "setup/compose.yaml", "dashboard/Dockerfile", "examples/github-workflows/static-checks.yml"]) {
    if (!existsSync(join(copy, f))) throw new Error(`missing ${f}`);
  }
  const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", USERPROFILE: process.env.USERPROFILE ?? "", SystemRoot: process.env.SystemRoot ?? "", APPDATA: process.env.APPDATA ?? "", TEMP: process.env.TEMP ?? "", TMP: process.env.TMP ?? "" };
  const npm = (cwd: string, ...args: string[]) => {
    const result = spawnSync("npm", args, { cwd, env, stdio: "inherit", shell: process.platform === "win32" });
    if (result.status !== 0) throw new Error(`npm ${args.join(" ")} failed in ${relative(copy, cwd) || "."}`);
  };
  npm(copy, "ci", "--ignore-scripts", "--silent");
  npm(join(copy, "foreman"), "ci", "--ignore-scripts", "--silent");
  npm(copy, "run", "--silent", "typecheck");
  npm(copy, "test", "--silent");
  console.log("check: ok");
} catch (error) {
  console.error(`check: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
