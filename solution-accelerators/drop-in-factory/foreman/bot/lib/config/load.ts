import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { CATALOG } from "../steps/catalog.ts";
import { parseFactory, type Factory } from "./factory.ts";

export function loadFactory(path: string): Factory {
  return parseFactory(parse(readFileSync(path, "utf8")), CATALOG);
}
