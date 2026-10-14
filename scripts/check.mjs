import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
function check(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) { check(file); continue; }
    if (!/\.(?:m?js)$/.test(entry.name)) continue;
    const result = spawnSync(process.execPath, ["--check", file], { stdio: "inherit" });
    if (result.status !== 0) process.exit(result.status || 1);
  }
}
for (const dir of ["src", "scripts", "test"]) check(dir);
