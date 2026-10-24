import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const version = JSON.parse(readFileSync("package.json", "utf8")).version;
const path = "worker/wrangler.toml";
const original = readFileSync(path, "utf8");

writeFileSync(path, original.replaceAll("__APP_VERSION__", `'${version}'`));
try {
  execSync("pnpm exec wrangler deploy", { cwd: "worker", stdio: "inherit" });
} finally {
  writeFileSync(path, original);
}
