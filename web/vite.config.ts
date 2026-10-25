import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");

/** 版本号取自仓库根 package.json（与 worker 侧版本注入同源）。 */
function readPackageVersion(): string {
  try {
    const raw = readFileSync(path.join(repoRoot, "package.json"), "utf8");
    const { version } = JSON.parse(raw) as { version?: string };
    return version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** 构建号：CI 注入 `BUILD_NUMBER`（github.run_number），本地缺省为 0。 */
function readBuildNumber(): string {
  const raw = process.env.BUILD_NUMBER?.trim();
  return raw && /^\d+$/.test(raw) ? raw : "0";
}

/** git 短 sha 前 7 位；无 git 仓库时降级为 `unknown`。 */
function readShortSha(): string {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .trim()
      .slice(0, 7) || "unknown";
  } catch {
    return "unknown";
  }
}

const appVersion = `v${readPackageVersion()}-${readBuildNumber()}-${readShortSha()}`;
const appBuildTime = new Date().toISOString();

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
    __APP_BUILD_TIME__: JSON.stringify(appBuildTime),
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
  },
  server: {
    proxy: {
      "/api": {
        target: "http://localhost:8787",
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
