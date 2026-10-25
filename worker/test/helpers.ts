import { DatabaseSync } from "node:sqlite";
import { app } from "../src/index";
import { SCHEMA_SQL } from "../src/db/schema";
import { getTablePrefix, type Env } from "../src/types";

export const TEST_JWT_SECRET = "test-jwt-secret-0123456789abcdef";
export const TEST_SETUP_SECRET = "test-setup-secret";

export type TestEnv = Record<string, unknown>;

/** 按 TABLE_PREFIX 解析生效前缀并替换 {prefix}（与运行时 ensureSchema 一致）。 */
export function resolveSchema(env: Pick<Env, "TABLE_PREFIX">): string {
  return SCHEMA_SQL.replace(/\{prefix\}/g, getTablePrefix(env));
}

export function makeEnv(overrides: TestEnv = {}): Env {
  const schema = resolveSchema({
    TABLE_PREFIX: overrides.TABLE_PREFIX,
  } as Pick<Env, "TABLE_PREFIX">);
  return {
    DB: new SqliteD1(schema),
    KV: new MockKV(),
    JWT_SECRET: TEST_JWT_SECRET,
    SETUP_SECRET: TEST_SETUP_SECRET,
    ASSETS: {} as unknown as Fetcher,
    ...overrides,
  } as unknown as Env;
}

export async function request(
  env: Env,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: any; res: Response }> {
  const res = await app.request(path, init, env);
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body, res };
}

export function jsonInit(
  method: string,
  body: unknown,
  headers: Record<string, string> = {},
): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  };
}

/** 从 Set-Cookie 里取出指定 cookie 值 */
export function cookieValue(res: Response, name: string): string | undefined {
  const cookies = res.headers.getSetCookie();
  for (const line of cookies) {
    const m = line.match(new RegExp(`^${name}=([^;]+)`));
    if (m) return m[1];
  }
  return undefined;
}

/** 组 Cookie 请求头 */
export function cookieHeader(...parts: [string, string | undefined][]): Record<string, string> {
  const valid = parts.filter(([, v]) => v !== undefined) as [string, string][];
  return { cookie: valid.map(([k, v]) => `${k}=${v}`).join("; ") };
}

export function setupSecretHeader(): Record<string, string> {
  return { "X-Setup-Secret": TEST_SETUP_SECRET };
}

export function ipHeader(ip: string): Record<string, string> {
  return { "cf-connecting-ip": ip };
}

// ─── KV mock（忽略 TTL，行为与 eNotify 测试同款） ─────────────────────────────

export class MockKV {
  store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.store.has(key) ? (this.store.get(key) ?? null) : null;
  }

  async put(
    key: string,
    value: string,
    _opts?: { expirationTtl?: number },
  ): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

// ─── D1 stand-in：真 SQLite（node:sqlite），保留列默认值/CHECK/FK 行为 ────────

export class SqliteD1 {
  readonly db: DatabaseSync;

  constructor(schema: string = SCHEMA_SQL, enableForeignKeys = true) {
    this.db = new DatabaseSync(":memory:");
    if (enableForeignKeys) this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(schema);
  }

  prepare(sql: string): {
    bind: (...args: unknown[]) => {
      first: <T>() => Promise<T | null>;
      all: <T>() => Promise<{ results: T[] }>;
      run: () => Promise<{ success: boolean; meta: { changes: number } }>;
    };
    first: <T>() => Promise<T | null>;
    all: <T>() => Promise<{ results: T[] }>;
    run: () => Promise<{ success: boolean; meta: { changes: number } }>;
  } {
    const statement = () => this.db.prepare(sql);
    const wrap = (args: unknown[]) => ({
      first: async <T>() =>
        ((statement().get(...(args as never[])) ?? null) as T | null),
      all: async <T>() => ({
        results: statement().all(...(args as never[])) as T[],
      }),
      run: async () => {
        const result = statement().run(...(args as never[]));
        return { success: true, meta: { changes: Number(result.changes) } };
      },
    });
    return {
      bind: (...args: unknown[]) => wrap(args),
      ...wrap([]),
    };
  }

  // D1 batch：生产环境单事务原子提交；测试替身按顺序执行（行为等价）。
  async batch(
    statements: {
      run: () => Promise<{ success: boolean; meta: { changes: number } }>;
    }[],
  ): Promise<{ success: boolean; meta: { changes: number } }[]> {
    const out: { success: boolean; meta: { changes: number } }[] = [];
    for (const s of statements) {
      out.push(await s.run());
    }
    return out;
  }
}

// ─── 流程辅助：完成 setup + 建号 + 登录 ──────────────────────────────────────

export async function doSetup(
  env: Env,
  email = "admin@example.com",
  password = "admin-password-123",
): Promise<void> {
  await request(env, "/api/setup", {
    method: "POST",
    headers: { "content-type": "application/json", ...setupSecretHeader() },
    body: JSON.stringify({ email, password }),
  });
}

export async function registerAndApprove(
  env: Env,
  adminCookies: Record<string, string>,
  email = "user@example.com",
  password = "user-password-123",
): Promise<string> {
  await request(
    env,
    "/api/auth/register",
    jsonInit("POST", { email, password }),
  );
  const users = (
    await request(env, "/api/admin/users", {
      headers: { ...adminCookies },
    })
  ).body as { id: string; email: string; approval_status: string }[];
  const target = users.find((u) => u.email === email);
  await request(env, `/api/admin/users/${target!.id}/approve`, {
    method: "PUT",
    headers: { ...adminCookies },
  });
  return target!.id;
}

export async function loginAndGetCookies(
  env: Env,
  email: string,
  password: string,
): Promise<{ access_token?: string; refresh_token?: string }> {
  const { res } = await request(
    env,
    "/api/auth/login",
    jsonInit("POST", { email, password }),
  );
  return {
    access_token: cookieValue(res, "access_token"),
    refresh_token: cookieValue(res, "refresh_token"),
  };
}
