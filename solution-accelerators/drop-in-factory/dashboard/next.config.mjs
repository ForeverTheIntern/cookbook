import { fileURLToPath } from "node:url";

/** @type {import("next").NextConfig} */
export default {
  // The Dockerfile sets this to ship only the traced server; `npm start` uses `next start`.
  output: process.env.NEXT_OUTPUT === "standalone" ? "standalone" : undefined,
  outputFileTracingRoot: fileURLToPath(new URL(".", import.meta.url)),
  serverExternalPackages: ["@electric-sql/pglite"],
};
