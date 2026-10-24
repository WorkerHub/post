import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { SCHEMA_SQL } from "../src/db/schema";

// 迁移文件与运行时建表用 SQL 必须逐字节一致（同一份契约两个入口）
describe("schema sync", () => {
  it("migrations/0001_init.sql matches SCHEMA_SQL", () => {
    // vitest 以 worker/ 为 cwd 运行
    const migration = readFileSync("migrations/0001_init.sql", "utf8");
    // 头部三行是生成说明注释，之后应与 SCHEMA_SQL 完全一致
    const lines = migration.split("\n");
    const body = lines.slice(3).join("\n");
    expect(body).toBe(SCHEMA_SQL);
  });
});

describe("schema (SPEC §4 冻结契约)", () => {
  function freshDb() {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(SCHEMA_SQL);
    return db;
  }

  it("creates all tables and indexes", () => {
    const db = freshDb();
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toEqual([
      "contacts",
      "letter_recipients",
      "letters",
      "system_settings",
      "user_2fa",
      "users",
    ]);

    const indexes = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name`)
      .all()
      .map((r) => (r as { name: string }).name);
    expect(indexes).toEqual([
      "idx_contacts_user_email",
      "idx_letter_recipients_letter",
      "idx_letters_status_send_at",
      "idx_letters_user_status",
    ]);
  });

  it("is idempotent (CREATE IF NOT EXISTS)", () => {
    const db = freshDb();
    expect(() => db.exec(SCHEMA_SQL)).not.toThrow();
  });

  it("letters.status CHECK rejects invalid enum", () => {
    const db = freshDb();
    db.prepare(
      `INSERT INTO users (id, email, password_hash, created_at, updated_at) VALUES ('u1','a@b.c','h','2026-01-01','2026-01-01')`,
    ).run();
    expect(() =>
      db
        .prepare(
          `INSERT INTO letters (id, user_id, created_at, updated_at) VALUES ('l1','u1','2026-01-01','2026-01-01')`,
        )
        .run(),
    ).not.toThrow(); // draft 默认值
    expect(() =>
      db
        .prepare(
          `INSERT INTO letters (id, user_id, status, created_at, updated_at) VALUES ('l2','u1','bogus','2026-01-01','2026-01-01')`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed/);
  });

  it("users.approval_status CHECK rejects invalid enum", () => {
    const db = freshDb();
    expect(() =>
      db
        .prepare(
          `INSERT INTO users (id, email, password_hash, approval_status, created_at, updated_at) VALUES ('u1','a@b.c','h','nope','2026-01-01','2026-01-01')`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed/);
  });

  it("letter_recipients cascades on letter delete; letters cascades on user delete", () => {
    const db = freshDb();
    db.prepare(
      `INSERT INTO users (id, email, password_hash, created_at, updated_at) VALUES ('u1','a@b.c','h','2026-01-01','2026-01-01')`,
    ).run();
    db.prepare(
      `INSERT INTO letters (id, user_id, status, created_at, updated_at) VALUES ('l1','u1','draft','2026-01-01','2026-01-01')`,
    ).run();
    db.prepare(
      `INSERT INTO letter_recipients (id, letter_id, email, created_at) VALUES ('r1','l1','x@y.z','2026-01-01')`,
    ).run();

    db.prepare(`DELETE FROM letters WHERE id='l1'`).run();
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM letter_recipients`).get(),
    ).toEqual({ n: 0 });

    db.prepare(
      `INSERT INTO letters (id, user_id, status, created_at, updated_at) VALUES ('l2','u1','scheduled','2026-01-01','2026-01-01')`,
    ).run();
    db.prepare(`DELETE FROM users WHERE id='u1'`).run();
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM letters`).get(),
    ).toEqual({ n: 0 });
  });

  it("contacts (user_id, email) is unique", () => {
    const db = freshDb();
    db.prepare(
      `INSERT INTO users (id, email, password_hash, created_at, updated_at) VALUES ('u1','a@b.c','h','2026-01-01','2026-01-01')`,
    ).run();
    db.prepare(
      `INSERT INTO contacts (id, user_id, email, created_at, updated_at) VALUES ('c1','u1','x@y.z','2026-01-01','2026-01-01')`,
    ).run();
    expect(() =>
      db
        .prepare(
          `INSERT INTO contacts (id, user_id, email, created_at, updated_at) VALUES ('c2','u1','x@y.z','2026-01-01','2026-01-01')`,
        )
        .run(),
    ).toThrow(/UNIQUE constraint failed/);
    // 同一邮箱不同用户允许
    db.prepare(
      `INSERT INTO users (id, email, password_hash, created_at, updated_at) VALUES ('u2','d@e.f','h','2026-01-01','2026-01-01')`,
    ).run();
    expect(() =>
      db
        .prepare(
          `INSERT INTO contacts (id, user_id, email, created_at, updated_at) VALUES ('c3','u2','x@y.z','2026-01-01','2026-01-01')`,
        )
        .run(),
    ).not.toThrow();
  });

  it("letters defaults: status=draft, is_public=0, attempts=0", () => {
    const db = freshDb();
    db.prepare(
      `INSERT INTO users (id, email, password_hash, created_at, updated_at) VALUES ('u1','a@b.c','h','2026-01-01','2026-01-01')`,
    ).run();
    db.prepare(
      `INSERT INTO letters (id, user_id, created_at, updated_at) VALUES ('l1','u1','2026-01-01','2026-01-01')`,
    ).run();
    const row = db
      .prepare(`SELECT status, is_public, attempts, send_at, body_json FROM letters WHERE id='l1'`)
      .get() as Record<string, unknown>;
    expect(row.status).toBe("draft");
    expect(row.is_public).toBe(0);
    expect(row.attempts).toBe(0);
    expect(row.send_at).toBeNull();
    expect(row.body_json).toBe("");
  });
});
