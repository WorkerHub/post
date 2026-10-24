import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "cloudflare:sockets": fileURLToPath(
        new URL("./test/stubs/sockets.ts", import.meta.url),
      ),
    },
  },
});
