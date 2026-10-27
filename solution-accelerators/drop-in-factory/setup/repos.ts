/**
 * `npm run -s repos`: one `--repo owner/name` per repository in factory.yaml,
 * for `agent-sdk serve --cursor-events $(npm run -s repos)`.
 */

import "../foreman/bot/lib/config/dotenv.ts";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pathsEnv } from "../foreman/bot/lib/config/env.ts";
import { loadFactory } from "../foreman/bot/lib/config/load.ts";

const factoryDir = fileURLToPath(new URL("..", import.meta.url));
const { repos } = loadFactory(resolve(factoryDir, pathsEnv().factoryConfig));
console.log(repos.map((r) => `--repo ${r.repo}`).join(" "));
