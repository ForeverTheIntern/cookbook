import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

// Just enough of a shell parser to tell which program each part of an agent's command runs, so
// the trajectory gate judges programs rather than words. It doesn't expand variables or globs.

export interface Segment {
  words: string[];
  // Targets of output redirects (`>`, `>>`, `&>`), so a read-only program that writes a file isn't benign.
  writes: string[];
}

const OPERATORS = ["&&", "||", ";;", ";", "|&", "|", "&", "\n", "(", ")"];

// macOS reaches the temp folder through /private/var, so paths are compared once links resolve.
export function real(p: string): string {
  let cur = resolve(p);
  const tail: string[] = [];
  while (!existsSync(cur) && dirname(cur) !== cur) {
    tail.unshift(basename(cur));
    cur = dirname(cur);
  }
  return join(realpathSync(cur), ...tail);
}

export function within(dir: string, p: string): boolean {
  const rel = relative(real(dir), real(p));
  return !rel.startsWith("..") && !isAbsolute(rel);
}

export function inTemp(p: string): boolean {
  return [tmpdir(), "/tmp"].some((d) => existsSync(d) && within(d, p));
}

function closing(text: string, start: number, open: string, close: string): number {
  let depth = 1;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") i++;
    else if (ch === "'" && open !== "`") {
      const end = text.indexOf("'", i + 1);
      i = end < 0 ? text.length : end;
    } else if (ch === open && open !== close) depth++;
    else if (ch === close && --depth === 0) return i;
  }
  return text.length;
}

// Splits a command line into simple commands. Command substitutions (`$(...)`, backticks) become
// segments of their own, heredoc bodies are dropped, and unquoted `#` starts a comment.
export function segments(cmd: string): Segment[] {
  const out: Segment[] = [];
  let words: string[] = [];
  let writes: string[] = [];
  let word = "";
  let inWord = false;
  let redirect: "write" | "read" | null = null;
  const heredocs: string[] = [];
  const endWord = () => {
    if (!inWord) return;
    if (redirect === "write") writes.push(word);
    else if (redirect !== "read") words.push(word);
    redirect = null;
    word = "";
    inWord = false;
  };
  const endSegment = () => {
    endWord();
    if (words.length || writes.length) out.push({ words, writes });
    words = [];
    writes = [];
  };
  const sub = (inner: string) => out.push(...segments(inner));
  // `$(pwd)` stays recognisable so a CLI path built from it still resolves; other substitutions don't.
  const substitution = (inner: string) => {
    sub(inner);
    return inner.trim() === "pwd" ? "$(pwd)" : "$(...)";
  };
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (ch === "\\" && i + 1 < cmd.length) {
      if (cmd[i + 1] !== "\n") word += cmd[i + 1];
      inWord = true;
      i++;
      continue;
    }
    if (ch === "'") {
      const end = cmd.indexOf("'", i + 1);
      word += cmd.slice(i + 1, end < 0 ? cmd.length : end);
      inWord = true;
      i = end < 0 ? cmd.length : end;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      for (; j < cmd.length && cmd[j] !== '"'; j++) {
        if (cmd[j] === "\\" && j + 1 < cmd.length) {
          word += cmd[++j];
        } else if (cmd[j] === "$" && cmd[j + 1] === "(") {
          const end = closing(cmd, j + 2, "(", ")");
          word += substitution(cmd.slice(j + 2, end));
          j = end;
        } else if (cmd[j] === "`") {
          const end = closing(cmd, j + 1, "`", "`");
          sub(cmd.slice(j + 1, end));
          word += "`...`";
          j = end;
        } else word += cmd[j];
      }
      inWord = true;
      i = j;
      continue;
    }
    if (ch === "$" && cmd[i + 1] === "(") {
      const end = closing(cmd, i + 2, "(", ")");
      word += substitution(cmd.slice(i + 2, end));
      inWord = true;
      i = end;
      continue;
    }
    if (ch === "`") {
      const end = closing(cmd, i + 1, "`", "`");
      sub(cmd.slice(i + 1, end));
      word += "`...`";
      inWord = true;
      i = end;
      continue;
    }
    if (ch === "#" && !inWord) {
      const nl = cmd.indexOf("\n", i);
      i = (nl < 0 ? cmd.length : nl) - 1;
      continue;
    }
    if (ch === "<" && cmd[i + 1] === "<" && cmd[i + 2] !== "<") {
      endWord();
      const m = cmd.slice(i + 2).match(/^-?\s*(['"]?)(\w+)\1/);
      if (m) {
        heredocs.push(m[2]);
        i += 1 + m[0].length;
        continue;
      }
    }
    if (ch === ">" || ch === "<" || (ch === "&" && cmd[i + 1] === ">")) {
      // `2>&1` and `>&2` duplicate a descriptor; anything else names a file.
      const fd = inWord && /^\d+$/.test(word);
      if (fd) {
        word = "";
        inWord = false;
      } else endWord();
      let j = i + (ch === "&" ? 2 : 1);
      if (cmd[j] === ">" && ch !== "<") j++;
      if (cmd[j] === "&") {
        const m = cmd.slice(j + 1).match(/^\s*(\d+|-)/);
        i = j + (m ? m[0].length : 0);
        continue;
      }
      redirect = ch === "<" ? "read" : "write";
      i = j - 1;
      continue;
    }
    const op = OPERATORS.find((o) => cmd.startsWith(o, i));
    if (op) {
      endSegment();
      if (op === "\n" && heredocs.length) {
        for (const tag of heredocs.splice(0)) {
          const rest = cmd.slice(i + 1);
          const m = rest.match(new RegExp(`(^|\\n)\\t*${tag}[ \\t]*(\\n|$)`));
          i = m ? i + 1 + m.index! + m[0].length - 1 : cmd.length;
        }
      } else i += op.length - 1;
      continue;
    }
    if (ch === " " || ch === "\t") {
      endWord();
      continue;
    }
    word += ch;
    inWord = true;
  }
  endSegment();
  return out;
}

const WRAPPERS = new Set(["time", "nohup", "command", "exec", "builtin", "nice", "sudo", "doas", "xargs", "stdbuf", "caffeinate"]);

// The program a simple command runs, past variable assignments and wrappers such as env and timeout.
export function program(words: string[]): string[] {
  let w = [...words];
  for (;;) {
    while (w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])) w = w.slice(1);
    if (!w.length) return w;
    const p = basename(w[0]);
    if (p === "env") {
      w = w.slice(1);
      while (w.length && (w[0].startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0]))) w = w.slice(w[0] === "-u" || w[0] === "-C" ? 2 : 1);
    } else if (p === "timeout") {
      w = w.slice(1);
      while (w.length && w[0].startsWith("-")) w = w.slice(/^-(s|k)$|^--(signal|kill-after)$/.test(w[0]) ? 2 : 1);
      w = w.slice(1);
    } else if (WRAPPERS.has(p)) {
      w = w.slice(1);
      while (w.length && w[0].startsWith("-")) w = w.slice(1);
    } else return w;
  }
}

export interface Context {
  // The repository the agent works in, and the directory the command runs from.
  repo: string;
  cwd: string;
}

export const CLI_PATH = ".cursor/skills/agent-readiness/scripts/readiness.ts";
// Node flags that only change how the CLI is parsed; anything else (--import, --require, -e) could run other code.
const CLI_NODE_FLAGS = /^--(experimental-strip-types|experimental-transform-types|no-warnings|disable-warning(=\S+)?|max-old-space-size=\d+|enable-source-maps)$/;

function at(ctx: Context, p: string): string {
  const q = p.replace(/^(\$\(pwd\)|\$\{PWD\}|\$PWD)(?=\/|$)/, ctx.cwd);
  return isAbsolute(q) ? q : resolve(ctx.cwd, q);
}

function inRepo(ctx: Context, p: string): boolean {
  return within(ctx.repo, at(ctx, p));
}

// `node <flags> <repo>/.cursor/skills/agent-readiness/scripts/readiness.ts ...`, matched on the
// script path the repo installs, not on the word "readiness" anywhere in the line.
export function isCliCall(words: string[], ctx: Context): boolean {
  const w = program(words);
  if (!w.length || !/^node(js)?$/.test(basename(w[0]))) return false;
  let i = 1;
  while (i < w.length && CLI_NODE_FLAGS.test(w[i])) i++;
  if (i >= w.length || w[i].startsWith("-")) return false;
  return real(at(ctx, w[i])) === real(join(ctx.repo, CLI_PATH));
}

const NPM_RUNS = new Set(["test", "t", "tst", "run", "run-script", "rum", "urn", "start", "stop", "restart", "ci", "clean-install", "install", "i", "in", "ins", "inst", "insta", "instal", "isnt", "isntal", "isntall", "add", "it", "cit", "install-test", "install-ci-test", "clean-install-test", "exec", "x", "rebuild", "rb", "explore", "pack", "publish"]);
const PM_HARMLESS = new Set(["--version", "-v", "-V", "--help", "-h", "help", "info", "view", "why", "list", "ls", "config", "outdated", "audit", "store", "bin", "root", "licenses", "env"]);
const RUNNERS = new Set(["npx", "pnpx", "bunx", "pytest", "py.test", "tox", "nox", "make", "gmake", "tsc", "vitest", "jest", "mocha", "ava", "tap", "playwright", "cypress", "eslint", "biome", "prettier", "ruff", "mypy", "pyright", "flake8", "black", "rspec", "phpunit", "rake", "gradle", "gradlew", "mvn", "mvnw", "turbo", "nx", "lerna", "tsx", "ts-node", "jasmine", "karma", "nodemon"]);
const BUILD_SUBS = new Set(["test", "run", "build", "bench", "generate", "vet", "check", "exec", "task", "install", "sync", "compile"]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
const PYTHON = /^python(\d+(\.\d+)*)?$/;

function firstArg(w: string[], from = 1): string | undefined {
  return w.slice(from).find((x) => !x.startsWith("-"));
}

// Why a simple command runs the repo's code (install, build, tests or a repo script) outside the
// readiness scripts, or null when it doesn't.
export function repoEvidence(words: string[], ctx: Context): string | null {
  const w = program(words);
  if (!w.length || isCliCall(w, ctx)) return null;
  const p = basename(w[0]);
  const line = w.join(" ");
  if (/^node(js)?$/.test(p)) {
    for (let i = 1; i < w.length; i++) {
      const a = w[i];
      if (a === "--test" || a.startsWith("--test=")) return line;
      if (["-e", "--eval", "-p", "--print"].includes(a)) {
        const code = w[i + 1] ?? "";
        return /(require|import)\s*\(\s*['"`]\.{0,2}\/|from\s+['"`]\.{1,2}\//.test(code) || code.includes(ctx.repo) ? line : null;
      }
      if (["--import", "--require", "-r", "--loader", "--experimental-loader"].includes(a)) {
        if (w[i + 1] && inRepo(ctx, w[i + 1])) return line;
        i++;
        continue;
      }
      if (a.startsWith("-")) continue;
      return inRepo(ctx, a) ? line : null;
    }
    return null;
  }
  if (p === "npm") {
    const sub = firstArg(w);
    return sub && NPM_RUNS.has(sub) ? line : null;
  }
  if (p === "pnpm" || p === "yarn" || p === "bun") {
    const sub = w[1];
    if (!sub) return p === "yarn" ? line : null;
    return PM_HARMLESS.has(sub) ? null : line;
  }
  if (p === "deno") return ["test", "run", "task", "bench", "compile", "install"].includes(w[1] ?? "") ? line : null;
  if (RUNNERS.has(p)) return line;
  if (["cargo", "go", "dotnet", "swift", "uv", "poetry", "pipenv", "pdm", "hatch", "rye", "composer", "bundle", "mix"].includes(p)) {
    const sub = firstArg(w);
    return sub && (BUILD_SUBS.has(sub) || (p === "uv" && sub === "pip")) ? line : null;
  }
  if (p === "pip" || p === "pip3") return firstArg(w) === "install" ? line : null;
  if (p === "docker" || p === "podman" || p === "docker-compose") {
    const rest = p === "docker-compose" ? w.slice(1) : w[1] === "compose" ? w.slice(2) : w.slice(1);
    const sub = firstArg(rest, 0);
    return sub && ["up", "run", "start", "build", "exec", "create"].includes(sub) ? line : null;
  }
  if (PYTHON.test(p)) {
    for (let i = 1; i < w.length; i++) {
      const a = w[i];
      if (a === "-m") return w[i + 1] === "json.tool" ? null : line;
      if (a === "-c") return /\bsys\.path\b|\bsrc\b|\btests?\b/.test(w[i + 1] ?? "") || (w[i + 1] ?? "").includes(ctx.repo) ? line : null;
      if (a.startsWith("-")) continue;
      return inRepo(ctx, a) ? line : null;
    }
    return null;
  }
  if (SHELLS.has(p)) {
    const c = w.indexOf("-c");
    if (c > 0 && w[c + 1] !== undefined) return commandEvidence(w[c + 1], ctx)[0] ?? null;
    const script = firstArg(w);
    return script && inRepo(ctx, script) ? line : null;
  }
  if (p === "eval") return commandEvidence(w.slice(1).join(" "), ctx)[0] ?? null;
  if (w[0].includes("/") && inRepo(ctx, w[0])) return line;
  return null;
}

// Each simple command in `cmd` that runs repo code outside the readiness scripts, following `cd`.
export function commandEvidence(cmd: string, ctx: Context): string[] {
  const out: string[] = [];
  let cwd = ctx.cwd;
  for (const s of segments(cmd)) {
    const w = program(s.words);
    if (w[0] === "cd" || w[0] === "pushd") {
      if (w[1] && !w[1].startsWith("$")) cwd = at({ ...ctx, cwd }, w[1] === "~" ? process.env.HOME ?? "/" : w[1]);
      continue;
    }
    const why = repoEvidence(s.words, { ...ctx, cwd });
    if (why) out.push(why);
  }
  return out;
}

const READ_ONLY = new Set(["cd", "pushd", "popd", "source", ".", "export", "set", "unset", "echo", "printf", "cat", "head", "tail", "less", "more", "ls", "pwd", "true", "false", "sleep", "wc", "grep", "egrep", "rg", "jq", "sort", "uniq", "test", "[", "which", "type", "date", "clear", "column", "cut", "tr", "basename", "dirname", "realpath", "readlink", "stat", "file", "diff"]);

// A call the protected-file rule lets change .agent-readiness/: one that runs the readiness CLI and,
// besides it, only read-only commands with no file redirects. A call made only of git commands is
// also let through; what git can restore there, the seal and the record cross-check catch.
export function cliOnly(cmd: string, ctx: Context): "cli" | "git" | null {
  const segs = segments(cmd);
  let cli = false;
  let gitOnly = segs.length > 0;
  let cwd = ctx.cwd;
  for (const s of segs) {
    const w = program(s.words);
    if (w[0] === "cd" && w[1]) cwd = at({ ...ctx, cwd }, w[1]);
    const benignWrites = s.writes.every((f) => /^\/dev\/(null|stdout|stderr)$/.test(f));
    if (isCliCall(s.words, { ...ctx, cwd })) {
      cli = true;
      gitOnly = false;
      continue;
    }
    if (w.length && basename(w[0]) === "git" && benignWrites) continue;
    gitOnly = false;
    if (!w.length && benignWrites) continue;
    if (w.length && READ_ONLY.has(basename(w[0])) && benignWrites) continue;
    return null;
  }
  return cli ? "cli" : gitOnly ? "git" : null;
}
