import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { SCHEMA_SQL } from "../src/db/schema";
import {
  DEFAULT_TABLE_PREFIX,
  getTablePrefix,
  isValidTablePrefix,
  tables,
  type Env,
} from "../src/types";
import { ensureSchema } from "../src/routes/setup";
import { countUsers } from "../src/db/queries/users";
import { SqliteD1 } from "./helpers";

describe("表前缀三态（ONE-269 冻结契约）", () => {
  it("默认前缀常量是唯一允许写死的表名常量", () => {
    expect(DEFAULT_TABLE_PREFIX).toBe("post_");
  });

  it("undefined → post_", () => {
    expect(getTablePrefix({ TABLE_PREFIX: undefined })).toBe("post_");
  });

  it("配置值原样返回（不自动补下划线）", () => {
    expect(getTablePrefix({ TABLE_PREFIX: "app_" })).toBe("app_");
    expect(getTablePrefix({ TABLE_PREFIX: "abc123" })).toBe("abc123");
  });

  it('"" → 显式无前缀', () => {
    expect(getTablePrefix({ TABLE_PREFIX: "" })).toBe("");
  });

  it("非法值抛错", () => {
    for (const bad of ["BadPrefix", "foo-bar", "foo bar", "foo.", "foo\\bar"]) {
      expect(() => getTablePrefix({ TABLE_PREFIX: bad })).toThrow(
        /must match \/^\[a-z0-9_\]\*\$\/|\^\[a-z0-9_\]\*\$/,
      );
    }
  });

  it("isValidTablePrefix 匹配小写字母/数字/下划线", () => {
    expect(isValidTablePrefix("post_")).toBe(true);
    expect(isValidTablePrefix("abc123_")).toBe(true);
    expect(isValidTablePrefix("")).toBe(true);
    expect(isValidTablePrefix("Bad")).toBe(false);
    expect(isValidTablePrefix("foo-bar")).toBe(false);
  });
});

describe("tables(env)", () => {
  it("默认前缀下返回六张 post_* 表", () => {
    expect(tables({ TABLE_PREFIX: undefined })).toEqual({
      users: "post_users",
      user_2fa: "post_user_2fa",
      letters: "post_letters",
      letter_recipients: "post_letter_recipients",
      contacts: "post_contacts",
      system_settings: "post_system_settings",
    });
  });

  it("无前缀时返回裸表名", () => {
    expect(tables({ TABLE_PREFIX: "" }).users).toBe("users");
    expect(tables({ TABLE_PREFIX: "" }).letters).toBe("letters");
  });
});

describe("SCHEMA_SQL（{prefix} 占位）", () => {
  function freshDb(prefix: string) {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(SCHEMA_SQL.replace(/\{prefix\}/g, prefix));
    return db;
  }

  it("不含裸表名（表/索引名均为 {prefix} 占位）", () => {
    expect(SCHEMA_SQL).not.toMatch(
      /CREATE TABLE IF NOT EXISTS (users|user_2fa|letters|letter_recipients|contacts|system_settings)[ (]/,
    );
    expect(SCHEMA_SQL).not.toMatch(/REFERENCES (users|letters)\(/);
    expect(SCHEMA_SQL).toContain("{prefix}users");
    expect(SCHEMA_SQL).toContain("{prefix}letters");
    expect(SCHEMA_SQL).toContain("idx_{prefix}letters_status_send_at");
  });

  it("替换 {prefix} 后建出带前缀的表与索引", () => {
    const db = freshDb("post_");
    const names = (type: string, onlyIdx = false) =>
      db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='${type}'${onlyIdx ? " AND name LIKE 'idx_%'" : ""} ORDER BY name`,
        )
        .all()
        .map((r) => (r as { name: string }).name);

    expect(names("table")).toEqual([
      "post_contacts",
      "post_letter_recipients",
      "post_letters",
      "post_system_settings",
      "post_user_2fa",
      "post_users",
    ]);
    expect(names("index", true)).toEqual([
      "idx_post_contacts_user_email",
      "idx_post_letter_recipients_letter",
      "idx_post_letters_status_send_at",
      "idx_post_letters_user_status",
    ]);
  });

  it("幂等（CREATE IF NOT EXISTS 可重复执行）", () => {
    const db = freshDb("post_");
    expect(() =>
      db.exec(SCHEMA_SQL.replace(/\{prefix\}/g, "post_")),
    ).not.toThrow();
  });

  it("外键级联与 CHECK 约束在带前缀建表下仍生效", () => {
    const db = freshDb("post_");
    db.prepare(
      `INSERT INTO post_users (id, email, password_hash, created_at, updated_at) VALUES ('u1','a@b.c','h','2026-01-01','2026-01-01')`,
    ).run();
    expect(() =>
      db
        .prepare(
          `INSERT INTO post_letters (id, user_id, status, created_at, updated_at) VALUES ('l1','u1','bogus','2026-01-01','2026-01-01')`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed/);
  });
});

describe("ensureSchema 建表与查询表名一致性", () => {
  function emptyEnv(prefix?: string) {
    const db = new SqliteD1("");
    return {
      DB: db as unknown as D1Database,
      TABLE_PREFIX: prefix,
    } as Env;
  }

  it("按生效前缀建表，返回实际生效前缀", async () => {
    const env = emptyEnv("kp_");
    const prefix = await ensureSchema(env);
    expect(prefix).toBe("kp_");

    const created = (env.DB as unknown as SqliteD1).db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => (r as { name: string }).name);

    expect(created).toContain("kp_users");
    expect(created).toContain("kp_letters");
    expect(created).not.toContain("users");
  });

  it("ensureSchema 建出的表名 === queries 实际引用的表名", async () => {
    const env = emptyEnv("x_");
    const prefix = await ensureSchema(env);

    // queries 与建表共用同一 prefix 解析：表存在则查询成功，表名不一致会抛错。
    await expect(countUsers(env.DB, prefix)).resolves.toBe(0);

    const t = tables(env);
    const created = (env.DB as unknown as SqliteD1).db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => (r as { name: string }).name);
    for (const name of Object.values(t)) {
      expect(created).toContain(name);
    }
  });
});
