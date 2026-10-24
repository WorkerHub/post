import { describe, expect, it } from "vitest";
import { app } from "../src/index";
import type { Env } from "../src/types";

const mockEnv = (indexHtml: string): Env =>
  ({
    DB: {} as D1Database,
    ASSETS: {
      fetch: async (input: RequestInfo | URL): Promise<Response> => {
        const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
        const path = new URL(url).pathname;
        return path === "/" || path === "/index.html"
          ? new Response(indexHtml, { headers: { "content-type": "text/html" } })
          : new Response("Not Found", { status: 404 });
      },
    },
  }) as Env;

describe("health", () => {
  it("returns ok", async () => {
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok" });
  });
});

describe("api fallback", () => {
  it("returns JSON 404 for unknown /api/* instead of index.html", async () => {
    const res = await app.request("/api/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ error: "Not found" });
  });
});

describe("spa fallback", () => {
  it("serves index.html for unknown non-API routes with mutable headers", async () => {
    const res = await app.request("/some-page", undefined, mockEnv("<html>index</html>"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<html>index</html>");
    // secureHeaders 必须能写入（ASSETS 响应头不可变会抛错）
    expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
  });
});
