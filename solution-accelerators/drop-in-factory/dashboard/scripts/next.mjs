// `node scripts/next.mjs dev|start`: runs Next on SA_PORTAL_PORT (default 8787)
// and HOSTNAME (default 127.0.0.1), without shell syntax, so it works on Windows too.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const mode = process.argv[2] === "start" ? "start" : "dev";
const port = process.env.SA_PORTAL_PORT?.trim() || "8787";
const host = mode === "start" ? process.env.HOSTNAME?.trim() || "127.0.0.1" : "127.0.0.1";
const next = createRequire(import.meta.url).resolve("next/dist/bin/next");
const child = spawn(process.execPath, [next, mode, "-H", host, "-p", port], { stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
