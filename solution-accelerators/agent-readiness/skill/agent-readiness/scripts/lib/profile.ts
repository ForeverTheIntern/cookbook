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

const NODE_LOCKFILES = ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"];
const PY_LOCKFILES = ["uv.lock", "poetry.lock", "Pipfile.lock", "pdm.lock"];
const LOCKFILES = [...NODE_LOCKFILES, ...PY_LOCKFILES, "packages.lock.json", "Cargo.lock", "go.sum", "Gemfile.lock", "composer.lock", "gradle.lockfile", "mix.lock", "pubspec.lock", "Podfile.lock"];
const SKIP_SEGMENT = /^(\..+|node_modules|fixtures?|__fixtures__|testdata|vendor|dist|build|bin|obj|target)$/;

// A solution file comes first so it groups the projects under it into one component.
const UNSUPPORTED_MANIFESTS: { match: RegExp; toolchain: string }[] = [
  { match: /\.sln$/, toolchain: ".NET" },
  { match: /\.(csproj|fsproj|vbproj)$/, toolchain: ".NET" },
  { match: /^go\.mod$/, toolchain: "Go" },
  { match: /^Cargo\.toml$/, toolchain: "Rust" },
  { match: /^(pom\.xml|build\.gradle(\.kts)?)$/, toolchain: "JVM" },
  { match: /^Gemfile$/, toolchain: "Ruby" },
  { match: /^composer\.json$/, toolchain: "PHP" },
];

interface FoundManifest {
  dir: string;
  kind: "js" | "py" | "other";
  manifest: string;
  toolchain?: string;
}

const within = (dir: string, parent: string) => parent === "." || dir === parent || dir.startsWith(parent + "/");

// Folders that usually hold tests, samples or tooling next to the product. A manifest there is a
// satellite: it becomes a component only when the repo has nothing else to assess.
const SATELLITE_SEGMENT = /^(tests?|__tests__|specs?|e2e|samples?|examples?|demos?|bench|benchmarks?|plugins?|utils?|configs?)$/;
const CONFIG_PACKAGE = /^(@[^/]+\/)?((eslint|prettier|stylelint|babel|jest|vitest|tsconfig|typescript)-config(-[\w.-]+)?|eslint-config|tsconfig|config)$/;

function satelliteReason(tree: string, m: FoundManifest): string | null {
  const segment = m.dir.split("/").find((s) => SATELLITE_SEGMENT.test(s));
  if (segment) return `it sits under ${segment}/, which usually holds tests, samples or tooling rather than the product`;
  const name = m.kind === "js" ? readPackageJson(join(tree, m.dir))?.name : undefined;
  if (name && CONFIG_PACKAGE.test(name)) return `${name} is a shared config package, not a product`;
  return null;
}

// Every manifest in the tree, at any depth, outside workspace members. A supported package owns
// the folders under it; one nested in an unsupported project (a web client inside a .NET project)
// is still its own component. Next to a root package, only nested packages with their own lockfile count.
function discoverManifests(tree: string, files: string[], claimed: string[], hasRoot: boolean): { found: FoundManifest[]; satellites: (FoundManifest & { reason: string })[] } {
  const byDir = new Map<string, string[]>();
  for (const f of files) {
    const dir = dirname(f);
    if (dir !== "." && dir.split("/").some((s) => SKIP_SEGMENT.test(s))) continue;
    byDir.set(dir, [...(byDir.get(dir) ?? []), basename(f)]);
  }
  const found: FoundManifest[] = [];
  const satellites: (FoundManifest & { reason: string })[] = [];
  const add = (m: FoundManifest) => {
    const reason = m.dir === "." ? null : satelliteReason(tree, m);
    if (reason) satellites.push({ ...m, reason });
    else found.push(m);
  };
  for (const dir of [...byDir.keys()].sort((a, b) => (a === "." ? -1 : b === "." ? 1 : a.split("/").length - b.split("/").length || a.localeCompare(b)))) {
    if (claimed.some((c) => within(dir, c))) continue;
    const names = byDir.get(dir)!;
    const has = (n: string) => names.includes(n);
    const insideSupported = [...found, ...satellites].some((f) => f.kind !== "other" && within(dir, f.dir));
    if (dir !== "." && !insideSupported && has("package.json") && (!hasRoot || NODE_LOCKFILES.some(has))) {
      add({ dir, kind: "js", manifest: `${dir}/package.json` });
      continue;
    }
    const py = has("pyproject.toml") ? "pyproject.toml" : has("setup.py") ? "setup.py" : has("requirements.txt") && names.some((n) => n.endsWith(".py")) ? "requirements.txt" : null;
    if (dir !== "." && !insideSupported && py && (!hasRoot || PY_LOCKFILES.some(has))) {
      add({ dir, kind: "py", manifest: `${dir}/${py}` });
      continue;
    }
    const rule = UNSUPPORTED_MANIFESTS.find((u) => names.some((n) => u.match.test(n)));
    if (rule && !(dir === "." && hasRoot) && ![...found, ...satellites].some((f) => within(dir, f.dir))) {
      const project = names.filter((n) => rule.match.test(n)).sort()[0];
      add({ dir, kind: "other", manifest: dir === "." ? project : `${dir}/${project}`, toolchain: rule.toolchain });
    }
  }
  return { found, satellites };
}

// The name a root-level project gives itself, so a Go module isn't called "go".
function projectName(tree: string, manifest: string): string {
  const text = exists(join(tree, manifest)) ? readText(join(tree, manifest)) : "";
  const named =
    manifest === "go.mod" ? text.match(/^module\s+(\S+)/m)?.[1]?.split("/").pop()
    : manifest === "Cargo.toml" || manifest === "pyproject.toml" ? text.match(/^name\s*=\s*["']([^"']+)["']/m)?.[1]
    : manifest === "pom.xml" ? text.match(/<artifactId>([^<]+)<\/artifactId>/)?.[1]
    : manifest === "composer.json" ? text.match(/"name"\s*:\s*"(?:[^"/]+\/)?([^"]+)"/)?.[1]
    : /\.(sln|csproj|fsproj|vbproj)$/.test(manifest) ? basename(manifest).replace(/\.\w+$/, "")
    : undefined;
  return named ?? "root";
}

function lockfileIn(tree: string, dir: string): string | null {
  const name = LOCKFILES.find((l) => exists(join(tree, dir, l)));
  return name ? (dir === "." ? name : `${dir}/${name}`) : null;
}

export function discoverComponents(tree: string, files: string[]): Component[] {
  return discoverLayout(tree, files).components;
}

export function discoverLayout(tree: string, files: string[]): { components: Component[]; satellites: Profile["satellites"] } {
  const comps: Component[] = [];
  const patterns = workspacePatterns(tree);
  if (patterns.length > 0) {
    const dirs = [...new Set(patterns.flatMap((p) => expandPattern(tree, p)))].filter((d) => exists(join(tree, d, "package.json"))).sort();
    for (const dir of dirs) {
      const pkg = readPackageJson(join(tree, dir));
      comps.push({
        id: dir === "." ? sanitizeId(pkg?.name ?? "root") : sanitizeId(basename(dir)),
        path: dir,
        language: languageOf(tree, dir, files),
        manifest: dir === "." ? "package.json" : `${dir}/package.json`,
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
    const pyName = exists(join(tree, "pyproject.toml")) ? readText(join(tree, "pyproject.toml")).match(/^name\s*=\s*["']([^"']+)["']/m)?.[1] : undefined;
    comps.push({ id: sanitizeId(pyName ?? "app"), path: ".", language: "py", manifest, scripts: {}, changes: 0, changeShare: 0, assessed: false });
  }
  const hasRoot = comps.some((c) => c.path === ".");
  const { found, satellites } = discoverManifests(tree, files, comps.filter((c) => c.path !== ".").map((c) => c.path), hasRoot);
  const deferred = comps.length === 0 && found.length === 0;
  for (const m of deferred ? satellites : found) {
    const pkg = m.kind === "js" ? readPackageJson(join(tree, m.dir)) : null;
    let id = sanitizeId(m.dir === "." ? projectName(tree, m.manifest) : basename(m.dir));
    if (comps.some((c) => c.id === id)) id = sanitizeId(m.dir.replace(/\//g, "-"));
    if (m.kind === "other") {
      comps.push({ id, path: m.dir, language: "other", manifest: m.manifest, scripts: {}, changes: 0, changeShare: 0, assessed: false, toolchain: m.toolchain, notAssessedReason: `${m.toolchain} isn't supported by this rubric` });
    } else {
      comps.push({ id, path: m.dir, language: m.kind === "js" ? languageOf(tree, m.dir, files) : "py", manifest: m.manifest, scripts: pkg?.scripts ?? {}, changes: 0, changeShare: 0, assessed: false, packageManager: detectPackageManager(join(tree, m.dir)) });
    }
  }
  for (const c of comps) c.lockfile = lockfileIn(tree, c.path);
  const satelliteList = deferred ? [] : satellites.map((s) => ({ path: s.dir, manifest: s.manifest, toolchain: s.kind === "js" ? "Node" : s.kind === "py" ? "Python" : s.toolchain!, reason: s.reason }));
  if (comps.length === 1 && comps[0].path === ".") return { components: comps, satellites: satelliteList };
  // Unsupported source with no manifest, such as infra/*.tf, is listed by its top-level folder.
  const claimed = new Set([...comps.map((c) => c.path), ...satelliteList.map((s) => s.path)].map((p) => p.split("/")[0]));
  const topDirs = [...new Set(files.filter((f) => f.includes("/")).map((f) => f.split("/")[0]))].filter((d) => !d.startsWith(".") && !claimed.has(d));
  for (const dir of topDirs.sort()) {
    const inside = files.filter((f) => f.startsWith(dir + "/"));
    const hit = UNSUPPORTED.find((u) => inside.some((f) => u.ext.test(f)));
    if (hit) {
      comps.push({ id: sanitizeId(dir), path: dir, language: "other", manifest: null, scripts: {}, changes: 0, changeShare: 0, assessed: false, toolchain: hit.toolchain, lockfile: null, notAssessedReason: `${hit.toolchain} isn't supported by this rubric` });
    }
  }
  return { components: comps, satellites: satelliteList };
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

function nodePins(tree: string, dir: string, pm: PackageManager | null, label: string, found: string[], missing: string[]): void {
  const pkg = readPackageJson(join(tree, dir));
  const prefix = dir === "." ? "" : `${dir}/`;
  const nodePin = [".nvmrc", ".node-version", ".tool-versions"].find((f) => exists(join(tree, dir, f)) || exists(join(tree, f)));
  if (nodePin) found.push(exists(join(tree, dir, nodePin)) ? `${prefix}${nodePin}` : nodePin);
  else if (pkg?.engines?.node) found.push(`${prefix}package.json engines.node`);
  else if (pkg?.volta?.node) found.push(`${prefix}package.json volta`);
  else missing.push(`the Node version${label} (.nvmrc or engines.node)`);
  if (pm === "pnpm" || pm === "yarn") {
    if (pkg?.packageManager) found.push(`${prefix}package.json packageManager`);
    else missing.push(`the ${pm} version${label} (packageManager in package.json)`);
  }
}

// Versions the repo's declared image pins, which count the same as a pin file.
function dockerfilePins(tree: string, dockerfile: string | undefined): { node: boolean; pm: Set<string>; python: boolean } {
  const out = { node: false, pm: new Set<string>(), python: false };
  if (!dockerfile || !exists(join(tree, ".cursor", dockerfile))) return out;
  const text = readText(join(tree, ".cursor", dockerfile));
  out.node = /^\s*FROM\s+(?:\S+\/)?node:\d/im.test(text) || /^\s*(ARG|ENV)\s+NODE_VERSION[= ]\s*\S/im.test(text);
  out.python = /^\s*FROM\s+(?:\S+\/)?python:\d/im.test(text) || /^\s*(ARG|ENV)\s+PYTHON_VERSION[= ]\s*\S/im.test(text);
  for (const m of text.matchAll(/\b(?:corepack\s+(?:prepare|install\s+-g)|npm\s+(?:i|install)\s+-g)\s+(pnpm|yarn)@\d/g)) out.pm.add(m[1]);
  for (const m of text.matchAll(/^\s*(?:ARG|ENV)\s+(PNPM|YARN)_VERSION[= ]\s*\S/gim)) out.pm.add(m[1].toLowerCase());
  return out;
}

function toolchain(tree: string, files: string[], pm: PackageManager | null, components: Component[], dockerfile?: string) {
  const found: string[] = [];
  let missing: string[] = [];
  const isNode = exists(join(tree, "package.json"));
  const isPy = files.some((f) => f.endsWith(".py"));
  if (isNode) nodePins(tree, ".", pm, "", found, missing);
  for (const c of components.filter((x) => x.packageManager && x.path !== ".")) {
    if (c.language !== "py") nodePins(tree, c.path, c.packageManager ?? null, ` for ${c.id}`, found, missing);
  }
  const nodeAnywhere = isNode || components.some((c) => c.packageManager && c.language !== "py");
  if (isPy && !nodeAnywhere) {
    if (exists(join(tree, ".python-version"))) found.push(".python-version");
    else missing.push("the Python version (.python-version)");
  }
  const pins = dockerfilePins(tree, dockerfile);
  const image = `.cursor/${dockerfile}`;
  missing = missing.filter((m) => !(pins.node && /the Node version/.test(m)) && !(pins.python && /the Python version/.test(m)) && ![...pins.pm].some((p) => m.startsWith(`the ${p} version`)));
  if (pins.node) found.push(`${image} (Node)`);
  if (pins.python) found.push(`${image} (Python)`);
  for (const p of pins.pm) found.push(`${image} (${p})`);
  if (found.length === 0 && missing.length === 0) missing.push("a toolchain version this rubric can read (.nvmrc, engines.node, .python-version or the declared image)");
  return { pinned: missing.length === 0 && found.length > 0, files: [...new Set(found)], missing };
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
  const { components, satellites } = discoverLayout(tree, files);
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
    manifests: files.filter((f) => /(^|\/)(package\.json|pyproject\.toml|setup\.py|requirements[^/]*\.txt|go\.mod|Cargo\.toml|pom\.xml|build\.gradle(\.kts)?|Gemfile|composer\.json|[^/]+\.(csproj|fsproj|vbproj|sln))$/.test(f) && !f.split("/").slice(0, -1).some((s) => SKIP_SEGMENT.test(s))),
    lockfiles: files.filter((f) => rubric.components.lockfiles.includes(basename(f)) && (dirname(f) === "." || components.some((c) => c.packageManager && c.path === dirname(f)))),
    ciFiles: files.filter((f) => /^\.github\/workflows\/.+\.ya?ml$/.test(f) || f === ".gitlab-ci.yml" || f === ".circleci/config.yml" || f.startsWith(".buildkite/")),
    instructionFiles: instructionFiles(files),
    toolchain: toolchain(tree, files, pm, components, environmentJson?.build?.dockerfile),
    environmentJson,
    components,
    satellites,
    historyDays: rubric.components.historyDays,
    totalChanges,
  };
}
