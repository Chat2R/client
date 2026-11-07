import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const roots = ["bin", "src"];
const files = [];
for (const root of roots) {
  for (const name of readdirSync(root)) {
    if (name.endsWith(".js")) files.push(join(root, name));
  }
}

for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status || 1);
}

console.log(`Syntax check passed for ${files.length} JavaScript files.`);
