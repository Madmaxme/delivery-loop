#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tsx = resolve(root, "node_modules/tsx/dist/cli.mjs");
const entry = resolve(root, "src/cli/main.ts");
const result = spawnSync(process.execPath, [tsx, entry, ...process.argv.slice(2)], {
  stdio: "inherit",
  cwd: process.cwd(),
  env: process.env,
});
process.exit(result.status ?? 1);
