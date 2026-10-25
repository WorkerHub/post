import { DatabaseSync } from "node:sqlite";
import { app } from "../src/index";
import {
  createMigrationsTableSql,
  getMigrations,
} from "../src/db/migrations";
import {
  getTablePrefix,
  migrationsTable,
  type Env,
} from "../src/types";

export const TEST_JWT_SECRET = "test-jwt-secret-0123456789abcdef";
export const TEST_SETUP_SECRET = "test-setup-secret";

/**
 * 按 TABLE_PREFIX 解析生效前缀，把迁移列表拼成一段可直接 exec 的 DDL。
 * （schema_v1 起的历史塌缩后只有一条迁移，拼起来即完整 schema。）
 */
export function resolveSchema(env: Pick<Env, "TABLE_PREFIX">): string {
  return getMigrations(getTablePrefix(env))
    .map((m) => m.sql)
    .join("\n");
}

/**
 * 建一个「已完成初始化」的内存库：全部迁移 + 账本都已落好，等同线上跑完 setup 之后。
 * 绝大多数业务测试只需要一个可用的库，不必重放 setup。
 */
export function makeMigratedDb(
  prefix: string,
  enableForeignKeys = true,
): SqliteD1 {
  const db = new SqliteD1("", enableForeignKeys);
  db.db.exec(createMigrationsTableSql(prefix));
  for (const migration of getMigrations(prefix)) {
    db.db.exec(migration.sql);
    db.db
      .prepare(`INSERT INTO ${migrationsTable(prefix)} (name) VALUES (?)`)
      .run(migration.name);
  }
  return db;
}

export function makeEnv(overrides: TestEnv = {}): Env {
  const prefix = getTablePrefix({
    TABLE_PREFIX: overrides.TABLE_PREFIX,
  } as Pick<Env, "TABLE_PREFIX">);
  return {
    DB: makeMigratedDb(prefix),
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

/** POST /api/setup 的请求体（ONE-313 冻结契约：只填 SETUP_SECRET，不建账号） */
export function setupInit(
  secret: string | null = TEST_SETUP_SECRET,
): RequestInit {
  return jsonInit("POST", secret === null ? {} : { setup_secret: secret });
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

export type TestEnv = Record<string, unknown>;

export class SqliteD1 {
  readonly db: DatabaseSync;

  constructor(schema: string = "", enableForeignKeys = true) {
    this.db = new DatabaseSync(":memory:");
    if (enableForeignKeys) this.db.exec("PRAGMA foreign_keys = ON");
    if (schema.trim() !== "") this.db.exec(schema);
  }

  // D1 exec：多语句执行（runner 用它跑一条迁移的整段 DDL）。
  async exec(sql: string): Promise<{ count: number; duration: number }> {
    this.db.exec(sql);
    return { count: 0, duration: 0 };
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

/** 完成初始化（只提交 SETUP_SECRET），随后用给定邮箱注册——即首个账号＝管理员。 */
export async function doSetup(
  env: Env,
  email = "admin@example.com",
  password = "admin-password-123",
): Promise<void> {
  await request(env, "/api/setup", setupInit());
  const reg = await request(env, "/api/auth/register", jsonInit("POST", { email, password }));
  if (reg.status !== 201) {
    throw new Error(`first register failed: ${reg.status} ${JSON.stringify(reg.body)}`);
  }
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
