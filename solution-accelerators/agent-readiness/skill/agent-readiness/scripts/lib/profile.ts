import { readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Rubric } from "./rubric.ts";
import type { Component, Language, PackageManager, Profile } from "./types.ts";
import { addDays, exists, git, listFiles, readJson, readText, today } from "./util.ts";

interface PackageJson {
  name?: string;
  scripts?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
  engines?: Record<string, string>;
  packageManager?: string;
  devDependencies?: Record<string, string>;
  dependencies?: Record<string, string>;
  volta?: Record<string, string>;
}

export function readPackageJson(dir: string): PackageJson | null {
  const p = join(dir, "package.json");
  if (!exists(p)) return null;
  try {
    return readJson<PackageJson>(p);
  } catch {
    return null;
  }
}

export function detectPackageManager(tree: string): PackageManager | null {
  if (exists(join(tree, "pnpm-lock.yaml"))) return "pnpm";
  if (exists(join(tree, "yarn.lock"))) return "yarn";
  if (exists(join(tree, "package-lock.json"))) return "npm";
  if (exists(join(tree, "package.json"))) {
    const pm = readPackageJson(tree)?.packageManager ?? "";
    if (pm.startsWith("pnpm")) return "pnpm";
    if (pm.startsWith("yarn")) return "yarn";
    return "npm";
  }
  if (exists(join(tree, "uv.lock"))) return "uv";
  if (exists(join(tree, "poetry.lock"))) return "poetry";
  if (exists(join(tree, "pyproject.toml")) || exists(join(tree, "requirements.txt")) || exists(join(tree, "setup.py"))) return "pip";
  return null;
}

function workspacePatterns(tree: string): string[] {
  const pkg = readPackageJson(tree);
  const ws = pkg?.workspaces;
  const fromPkg = Array.isArray(ws) ? ws : ws?.packages ?? [];
  const pnpmFile = join(tree, "pnpm-workspace.yaml");
  const fromPnpm: string[] = [];
  if (exists(pnpmFile)) {
    let inPackages = false;
    for (const line of readText(pnpmFile).split("\n")) {
      if (/^packages\s*:/.test(line)) {
        inPackages = true;
        continue;
      }
      if (inPackages) {
        const m = line.match(/^\s*-\s*['"]?([^'"#]+?)['"]?\s*$/);
        if (m) fromPnpm.push(m[1]);
        else if (/^\S/.test(line)) inPackages = false;
      }
    }
  }
  return [...fromPkg, ...fromPnpm].filter((p) => !p.startsWith("!"));
}

function expandPattern(tree: string, pattern: string): string[] {
  const clean = pattern.replace(/\/+$/, "");
  if (clean.endsWith("/*") || clean.endsWith("/**")) {
    const base = clean.replace(/\/\*\*?$/, "");
    const dir = join(tree, base);
    if (!exists(dir)) return [];
    return readdirSync(dir)
      .filter((n) => statSync(join(dir, n)).isDirectory())
      .map((n) => `${base}/${n}`);
  }
  return exists(join(tree, clean)) ? [clean] : [];
}

function languageOf(tree: string, path: string, files: string[]): Language {
  const inside = files.filter((f) => path === "." || f.startsWith(path + "/"));
  if (inside.some((f) => /\.(ts|tsx|mts|cts)$/.test(f) && !f.endsWith(".d.ts"))) return "ts";
  if (exists(join(tree, path, "package.json"))) return "js";
  if (inside.some((f) => f.endsWith(".py"))) return "py";
  return "other";
}

const UNSUPPORTED: { ext: RegExp; toolchain: string }[] = [
  { ext: /\.tf$/, toolchain: "Terraform" },
  { ext: /\.go$/, toolchain: "Go" },
  { ext: /\.rs$/, toolchain: "Rust" },
  { ext: /\.(java|kt|scala)$/, toolchain: "JVM" },
  { ext: /\.(cs|fs)$/, toolchain: ".NET" },
  { ext: /\.(rb)$/, toolchain: "Ruby" },
];

function sanitizeId(name: string): string {
  return name.replace(/^@[^/]+\//, "").replace(/[^A-Za-z0-9._-]/g, "-") || "root";
}

export function discoverComponents(tree: string, files: string[]): Component[] {
  const comps: Component[] = [];
  const patterns = workspacePatterns(tree);
  if (patterns.length > 0) {
    const dirs = [...new Set(patterns.flatMap((p) => expandPattern(tree, p)))].filter((d) => exists(join(tree, d, "package.json"))).sort();
    for (const dir of dirs) {
      const pkg = readPackageJson(join(tree, dir));
      comps.push({
        id: sanitizeId(basename(dir)),
        path: dir,
        language: languageOf(tree, dir, files),
        manifest: `${dir}/package.json`,
        scripts: pkg?.scripts ?? {},
        changes: 0,
        changeShare: 0,
        assessed: false,
      });
    }
  } else if (exists(join(tree, "package.json"))) {
    const pkg = readPackageJson(tree);
    comps.push({ id: sanitizeId(pkg?.name ?? "root"), path: ".", language: languageOf(tree, ".", files), manifest: "package.json", scripts: pkg?.scripts ?? {}, changes: 0, changeShare: 0, assessed: false });
  } else if (exists(join(tree, "pyproject.toml")) || exists(join(tree, "setup.py")) || exists(join(tree, "requirements.txt"))) {
    const manifest = exists(join(tree, "pyproject.toml")) ? "pyproject.toml" : exists(join(tree, "setup.py")) ? "setup.py" : "requirements.txt";
    comps.push({ id: sanitizeId(basename(tree) === "tree" ? "root" : basename(tree)), path: ".", language: "py", manifest, scripts: {}, changes: 0, changeShare: 0, assessed: false });
  }
  if (comps.length === 1 && comps[0].path === ".") return comps;
  const claimed = new Set(comps.map((c) => c.path.split("/")[0]));
  const topDirs = [...new Set(files.filter((f) => f.includes("/")).map((f) => f.split("/")[0]))].filter((d) => !d.startsWith(".") && !claimed.has(d));
  for (const dir of topDirs.sort()) {
    const inside = files.filter((f) => f.startsWith(dir + "/"));
    const hit = UNSUPPORTED.find((u) => inside.some((f) => u.ext.test(f)));
    if (hit) {
      comps.push({ id: sanitizeId(dir), path: dir, language: "other", manifest: null, scripts: {}, changes: 0, changeShare: 0, assessed: false, notAssessedReason: `${hit.toolchain} isn't supported by this rubric` });
    }
  }
  return comps;
}

function owningComponent(file: string, comps: Component[]): Component | null {
  let best: Component | null = null;
  let bestLen = -1;
  for (const c of comps) {
    const matches = c.path === "." || file === c.path || file.startsWith(c.path + "/");
    const len = c.path === "." ? 0 : c.path.length;
    if (matches && len > bestLen) {
      best = c;
      bestLen = len;
    }
  }
  return best;
}

export function computeChangeShares(repo: string, comps: Component[], rubric: Rubric): number {
  const since = addDays(today(), -rubric.components.historyDays);
  const r = git(["log", `--since=${since}`, "--no-merges", "--name-status", "--no-renames", "--format=@@%an%x09%ae"], repo);
  const counts = new Map<string, number>();
  let author = "";
  let commitFiles: string[] = [];
  const flush = () => {
    const isBot = rubric.components.botAuthorPatterns.some((p) => author.toLowerCase().includes(p.toLowerCase()));
    const lockOnly = commitFiles.length > 0 && commitFiles.every((f) => rubric.components.lockfiles.includes(basename(f)));
    if (!isBot && !lockOnly) {
      for (const f of commitFiles) {
        if (rubric.components.generatedPatterns.some((g) => f.includes(g))) continue;
        if (rubric.components.lockfiles.includes(basename(f))) continue;
        const owner = owningComponent(f, comps);
        if (owner) counts.set(owner.id, (counts.get(owner.id) ?? 0) + 1);
      }
    }
    commitFiles = [];
  };
  if (r.ok) {
    for (const line of r.stdout.split("\n")) {
      if (line.startsWith("@@")) {
        flush();
        author = line.slice(2);
      } else if (/^[AMD]\t/.test(line)) {
        commitFiles.push(line.slice(2));
      }
    }
    flush();
  }
  let total = 0;
  for (const c of comps) {
    c.changes = counts.get(c.id) ?? 0;
    total += c.changes;
  }
  for (const c of comps) c.changeShare = total > 0 ? Math.round((c.changes / total) * 1000) / 1000 : Math.round((1 / comps.length) * 1000) / 1000;
  return total;
}

function toolchain(tree: string, files: string[], pm: PackageManager | null) {
  const found: string[] = [];
  const missing: string[] = [];
  const pkg = readPackageJson(tree);
  const isNode = exists(join(tree, "package.json"));
  const isPy = files.some((f) => f.endsWith(".py"));
  if (isNode) {
    const nodePin = [".nvmrc", ".node-version", ".tool-versions"].find((f) => exists(join(tree, f)));
    if (nodePin) found.push(nodePin);
    else if (pkg?.engines?.node) found.push("package.json engines.node");
    else if (pkg?.volta?.node) found.push("package.json volta");
    else missing.push("the Node version (.nvmrc or engines.node)");
    if (pm === "pnpm" || pm === "yarn") {
      if (pkg?.packageManager) found.push("package.json packageManager");
      else missing.push(`the ${pm} version (packageManager in package.json)`);
    }
  }
  if (isPy && !isNode) {
    if (exists(join(tree, ".python-version"))) found.push(".python-version");
    else missing.push("the Python version (.python-version)");
  }
  return { pinned: missing.length === 0 && found.length > 0, files: found, missing };
}

const INSTRUCTION_PATTERNS: RegExp[] = [
  /(^|\/)AGENTS\.md$/,
  /(^|\/)CLAUDE\.md$/,
  /^\.cursorrules$/,
  /^\.cursor\/rules\/.+\.(mdc|md)$/,
  /^\.github\/copilot-instructions\.md$/,
  /^\.github\/instructions\/.+\.instructions\.md$/,
  /^\.(cursor|claude|agents)\/skills\/[^/]+\/SKILL\.md$/,
  /^README\.md$/i,
];

export function instructionFiles(files: string[]): string[] {
  return files.filter((f) => INSTRUCTION_PATTERNS.some((p) => p.test(f)) && !f.startsWith(".cursor/skills/agent-readiness/"));
}

export function buildProfile(repo: string, tree: string, rubric: Rubric): Profile {
  const files = listFiles(tree, { includeHidden: true });
  const pm = detectPackageManager(tree);
  const components = discoverComponents(tree, files);
  const totalChanges = computeChangeShares(repo, components, rubric);
  const supported = components.filter((c) => !c.notAssessedReason && rubric.mutation.languages.includes(c.language === "other" ? "x" : c.language));
  for (const c of components) {
    if (!c.notAssessedReason && c.language === "other") c.notAssessedReason = "no supported toolchain found";
  }
  supported.sort((a, b) => b.changeShare - a.changeShare);
  supported.slice(0, rubric.components.maxAssessed).forEach((c) => (c.assessed = true));
  supported.slice(rubric.components.maxAssessed).forEach((c) => (c.notAssessedReason = `outside the ${rubric.components.maxAssessed} most active components`));
  const envPath = join(tree, ".cursor", "environment.json");
  let environmentJson: Profile["environmentJson"] = null;
  if (exists(envPath)) {
    try {
      const env = readJson<{ install?: string; start?: string; build?: { dockerfile?: string; context?: string } }>(envPath);
      environmentJson = { path: ".cursor/environment.json", install: env.install, start: env.start, build: env.build?.dockerfile ? { dockerfile: env.build.dockerfile, context: env.build.context } : undefined };
    } catch {
      environmentJson = { path: ".cursor/environment.json" };
    }
  }
  return {
    repoType: components.filter((c) => c.manifest).length > 1 ? "monorepo" : "single",
    packageManager: pm,
    manifests: files.filter((f) => /(^|\/)(package\.json|pyproject\.toml|setup\.py|requirements[^/]*\.txt|go\.mod|Cargo\.toml)$/.test(f)),
    lockfiles: files.filter((f) => rubric.components.lockfiles.includes(basename(f)) && dirname(f) === "."),
    ciFiles: files.filter((f) => /^\.github\/workflows\/.+\.ya?ml$/.test(f) || f === ".gitlab-ci.yml" || f === ".circleci/config.yml" || f.startsWith(".buildkite/")),
    instructionFiles: instructionFiles(files),
    toolchain: toolchain(tree, files, pm),
    environmentJson,
    components,
    historyDays: rubric.components.historyDays,
    totalChanges,
  };
}
