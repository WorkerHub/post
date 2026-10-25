import { describe, expect, it } from "vitest";
import { getMigrations, type Migration } from "../src/db/migrations";
import {
  runMigrations,
  TablePrefixConflictError,
} from "../src/lib/migrations-runner";
import { migrationsTable, type Env } from "../src/types";
import { SqliteD1 } from "./helpers";

// ─── 工具 ────────────────────────────────────────────────────────────────────

function emptyEnv(prefix?: string): { env: Env; sqlite: SqliteD1 } {
  const sqlite = new SqliteD1("");
  const env = {
    DB: sqlite as unknown as D1Database,
    TABLE_PREFIX: prefix,
  } as Env;
  return { env, sqlite };
}

function tableNames(sqlite: SqliteD1): string[] {
  return sqlite.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r) => (r as { name: string }).name);
}

function schemaSnapshot(sqlite: SqliteD1): string {
  return JSON.stringify(
    sqlite.db
      .prepare(
        "SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name",
      )
      .all(),
  );
}

function ledgerNames(sqlite: SqliteD1, prefix: string): string[] {
  return sqlite.db
    .prepare(`SELECT name FROM ${migrationsTable(prefix)} ORDER BY name`)
    .all()
    .map((r) => (r as { name: string }).name);
}

/** 在 `prefix` 下把当前全部迁移落库（模拟「已按该前缀初始化」）。 */
async function initialize(prefix: string): Promise<{ env: Env; sqlite: SqliteD1 }> {
  const { env, sqlite } = emptyEnv(prefix);
  await runMigrations(env);
  return { env, sqlite };
}

// ─── 账本表名（ONE-347 冻结契约 §1）──────────────────────────────────────────

describe("migrationsTable() 命名三态", () => {
  it("默认前缀 post_ → _post_schema_migrations", () => {
    expect(migrationsTable("post_")).toBe("_post_schema_migrations");
  });

  it("自定义前缀 → _<前缀核>_schema_migrations", () => {
    expect(migrationsTable("kp_")).toBe("_kp_schema_migrations");
    expect(migrationsTable("my_app_")).toBe("_my_app_schema_migrations");
    // 未自带尾部下划线的前缀也按「前缀核」处理（只去掉一层尾部下划线）
    expect(migrationsTable("abc123")).toBe("_abc123_schema_migrations");
  });

  it("显式空前缀 → _schema_migrations", () => {
    expect(migrationsTable("")).toBe("_schema_migrations");
  });

  it("大小写原值保留、不规范化", () => {
    expect(migrationsTable("Post_")).toBe("_Post_schema_migrations");
    expect(migrationsTable("MY_APP_")).toBe("_MY_APP_schema_migrations");
  });
});

// ─── runner 语义 ─────────────────────────────────────────────────────────────

describe("runMigrations（空库首跑 / 重跑）", () => {
  it("空库首跑：全部 applied，账本恰含 schema_v1，表与索引建好", async () => {
    const { env, sqlite } = emptyEnv();
    const result = await runMigrations(env);

    expect(result.prefix).toBe("post_");
    expect(result.migrations).toEqual([
      { name: "schema_v1", status: "applied" },
    ]);

    // 账本恰含一条 schema_v1
    expect(tableNames(sqlite)).toContain("_post_schema_migrations");
    expect(ledgerNames(sqlite, "post_")).toEqual(["schema_v1"]);

    // 业务表 + 索引都建出来了
    const names = tableNames(sqlite);
    for (const t of [
      "post_users",
      "post_user_2fa",
      "post_letters",
      "post_letter_recipients",
      "post_contacts",
      "post_system_settings",
    ]) {
      expect(names).toContain(t);
    }
    const indexes = sqlite.db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(indexes.sort()).toEqual([
      "idx_post_contacts_user_email",
      "idx_post_letter_recipients_letter",
      "idx_post_letters_status_send_at",
      "idx_post_letters_user_status",
    ]);
  });

  it("第二跑：全部 skipped，且 schema 无任何变化", async () => {
    const { env, sqlite } = await initialize("post_");
    const before = schemaSnapshot(sqlite);

    const result = await runMigrations(env);
    expect(result.migrations).toEqual([
      { name: "schema_v1", status: "skipped" },
    ]);
    expect(schemaSnapshot(sqlite)).toBe(before);
    expect(ledgerNames(sqlite, "post_")).toEqual(["schema_v1"]);
  });

  it("自定义前缀与显式空前缀同样走账本", async () => {
    const custom = await emptyEnv("kp_");
    expect((await runMigrations(custom.env)).prefix).toBe("kp_");
    expect(ledgerNames(custom.sqlite, "kp_")).toEqual(["schema_v1"]);

    const none = await emptyEnv("");
    expect((await runMigrations(none.env)).prefix).toBe("");
    expect(tableNames(none.sqlite)).toContain("_schema_migrations");
    expect(ledgerNames(none.sqlite, "")).toEqual(["schema_v1"]);
    expect(tableNames(none.sqlite)).toContain("users");
  });
});

describe("runMigrations 防静默切换（前缀冲突）", () => {
  it("库里已按 post_ 初始化，但 TABLE_PREFIX 显式空 → 中止报错且不建裸表", async () => {
    const { sqlite } = await initialize("post_");

    const env = {
      DB: sqlite as unknown as D1Database,
      TABLE_PREFIX: "",
    } as Env;

    await expect(runMigrations(env)).rejects.toBeInstanceOf(
      TablePrefixConflictError,
    );
    expect(tableNames(sqlite)).not.toContain("users");
  });

  it("库里是无前缀 schema，但 TABLE_PREFIX 走默认 post_ → 中止报错", async () => {
    const { sqlite } = await initialize("");

    const env = {
      DB: sqlite as unknown as D1Database,
      TABLE_PREFIX: undefined,
    } as Env;

    await expect(runMigrations(env)).rejects.toThrow(/无前缀 schema/);
  });

  it("同前缀 + 账本已存在 → 增量放行（skipped），不算冲突", async () => {
    const { env, sqlite } = await initialize("post_");
    // 共享库里他应用的 bare users 表不应触发误判
    sqlite.db.exec("CREATE TABLE users (id TEXT PRIMARY KEY);");

    const result = await runMigrations(env);
    expect(result.migrations).toEqual([
      { name: "schema_v1", status: "skipped" },
    ]);
  });

  it("共享库里其他项目的账本表不误杀 post 的首次 setup（ONE-347 回归）", async () => {
    const { env, sqlite } = emptyEnv();
    // shortlink / Zeta 账本化后在同一个共享 D1 里留下的账本表
    sqlite.db.exec(
      "CREATE TABLE _SL_schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL DEFAULT (unixepoch()));" +
        "CREATE TABLE _ZETA_schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL DEFAULT (unixepoch()));" +
        "CREATE TABLE SL_links (id TEXT);" +
        "CREATE TABLE ZETA_users (id TEXT);" +
        "CREATE TABLE nav_users (id TEXT);",
    );

    const result = await runMigrations(env);
    expect(result.prefix).toBe("post_");
    expect(result.migrations).toEqual([
      { name: "schema_v1", status: "applied" },
    ]);
  });
});

describe("runMigrations 失败注入", () => {
  /** [v1 正常, v2 坏 SQL, v3 正常] —— 用于验证「失败项不落账、后续不执行」。 */
  const broken: Migration[] = [
    { name: "schema_v1", sql: "CREATE TABLE IF NOT EXISTS t1 (id TEXT);" },
    {
      name: "schema_v2",
      sql: "CREATE TABLE IF NOT EXISTS t2 (id TEXT);\nCREATE TABLE t2 broken syntax here;",
    },
    { name: "schema_v3", sql: "CREATE TABLE IF NOT EXISTS t3 (id TEXT);" },
  ];

  it("某条迁移失败：该项不落账、后续不执行、前面的照常记入", async () => {
    const { env, sqlite } = emptyEnv();
    const result = await runMigrations(env, broken);

    expect(
      result.migrations.map((m) => [m.name, m.status]),
    ).toEqual([
      ["schema_v1", "applied"],
      ["schema_v2", "error"],
    ]);
    expect(result.migrations[1]?.error).toBeTruthy();

    // 账本只有成功的那条，失败项与后续项都没落账
    expect(ledgerNames(sqlite, "post_")).toEqual(["schema_v1"]);
    // 后续迁移没执行
    expect(tableNames(sqlite)).not.toContain("t3");
  });

  it("修好失败项后重跑：跳过已应用项，从失败项继续", async () => {
    const { env, sqlite } = emptyEnv();
    await runMigrations(env, broken);

    const fixed: Migration[] = [
      broken[0]!,
      { name: "schema_v2", sql: "CREATE TABLE IF NOT EXISTS t2 (id TEXT);" },
      broken[2]!,
    ];
    const second = await runMigrations(env, fixed);

    expect(second.migrations.map((m) => [m.name, m.status])).toEqual([
      ["schema_v1", "skipped"],
      ["schema_v2", "applied"],
      ["schema_v3", "applied"],
    ]);
    expect(ledgerNames(sqlite, "post_")).toEqual([
      "schema_v1",
      "schema_v2",
      "schema_v3",
    ]);
    expect(tableNames(sqlite)).toContain("t3");
  });
});

describe("迁移列表内容约束", () => {
  it("迁移名唯一且以 schema_vN 递增命名", () => {
    const names = getMigrations("post_").map((m) => m.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names[0]).toBe("schema_v1");
  });

  it("每条迁移 SQL 非空", () => {
    for (const m of getMigrations("post_")) {
      expect(m.sql.trim().length).toBeGreaterThan(0);
    }
  });
});
