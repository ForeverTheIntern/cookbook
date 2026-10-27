import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const read = (path: string) => readFileSync(join(root, path), "utf8");

/** Shell syntax that bash and zsh accept and PowerShell or cmd.exe do not. */
const BASH_ONLY: [RegExp, string][] = [
  [/\bset -a\b/, "set -a"],
  [/(^|\s)\. \.\//, "sourcing with ."],
  [/\$\{/, "${…} expansion"],
  [/\$\(/, "$(…) substitution"],
  [/\bpkill\b/, "pkill"],
  [/(^|\s)export \w+=/, "export"],
  [/\(cd /, "(cd …) subshell"],
  [/(^|[;&|]\s*)[A-Z_]+=\S* +(npm|node|npx)\b/, "VAR=value command"],
  [/\bsed -i\b/, "sed -i"],
  [/\brsync\b/, "rsync"],
  [/\bfor \w+ in\b/, "for … in loop"],
];

function offenses(text: string): string[] {
  return BASH_ONLY.filter(([pattern]) => pattern.test(text)).map(([, name]) => name);
}

/** Lines inside ```bash, ```sh, ```shell, ```powershell and bare ``` fences. */
function shellLines(markdown: string): string[] {
  const lines: string[] = [];
  let fence: string | null = null;
  for (const line of markdown.split("\n")) {
    const marker = /^\s*```(\w*)/.exec(line);
    if (marker !== null) {
      fence = fence === null ? marker[1] : null;
      continue;
    }
    if (fence !== null && ["", "bash", "sh", "shell", "powershell"].includes(fence)) lines.push(line);
  }
  return lines;
}

test("npm scripts use no bash-only syntax", () => {
  for (const pkg of ["package.json", "dashboard/package.json"]) {
    const scripts: Record<string, string> = JSON.parse(read(pkg)).scripts ?? {};
    for (const [name, command] of Object.entries(scripts)) assert.deepEqual(offenses(command), [], `${pkg} script ${name}: ${command}`);
  }
});

test("setup docs' shell fences run in PowerShell too", () => {
  for (const doc of ["README.md", "docs/reference.md", "docs/tutorial.md", "PREREQUISITES.md", "TESTING.md", "docs/agent-setup.md"]) {
    for (const line of shellLines(read(doc))) assert.deepEqual(offenses(line.replace(/#.*$/, "")), [], `${doc}: ${line}`);
  }
});

test("the guard catches what it names", () => {
  assert.deepEqual(offenses("set -a; . ./.env; set +a"), ["set -a", "sourcing with ."]);
  assert.deepEqual(offenses("SA_VERIFY_HOSTED=1 npm run doctor"), ["VAR=value command"]);
  assert.deepEqual(offenses("next dev -p ${SA_PORTAL_PORT:-8787}"), ["${…} expansion"]);
  assert.deepEqual(offenses("npm run doctor -- --hosted"), []);
});
