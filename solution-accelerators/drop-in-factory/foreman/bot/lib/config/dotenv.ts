/**
 * Import first in every script: loads the factory folder's `.env` into the
 * environment, so no shell has to source it. Variables already set win.
 */

import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";

const file = new URL("../../../../.env", import.meta.url);
if (existsSync(file)) loadEnvFile(file);
