// 迁移 runner（ONE-347，照 shortlink `apps/worker/src/lib/migrations-runner.ts` 形态）。
//
// setup 公开入口（routes/setup.ts → POST /api/setup）与管理员入口
// （routes/admin-system.ts → POST /api/admin/db-upgrade）共用本文件的 runMigrations()，
// 不得双份维护。
//
// 语义：
// 1. 先按现行 TABLE_PREFIX 三态规则解析生效前缀（三态语义本次不动）；
// 2. 防静默切换：库中已按其他前缀初始化时中止报错，绝不按新前缀另建一套；
// 3. 建账本表（IF NOT EXISTS）→ 读已应用集合 → 按序执行未记录项，成功后立即写一行；
// 4. 首个失败即停、报错，且**不给失败项落账**（下次重跑会重试它）。

import type { Env } from "../types";
import {
  DEFAULT_TABLE_PREFIX,
  getTablePrefix,
  migrationsTable,
  prefixCore,
} from "../types";
import {
  createMigrationsTableSql,
  getMigrations,
  type Migration,
} from "../db/migrations";

export interface MigrationResult {
  name: string;
  status: "applied" | "skipped" | "error";
  error?: string;
}

export interface RunMigrationsResult {
  /** 本次实际生效的表前缀（显式无前缀时为 ""） */
  prefix: string;
  migrations: MigrationResult[];
}

/** 对外响应摘要（POST /api/setup 与 POST /api/admin/db-upgrade 共用同一形状）。 */
export interface SchemaReport {
  /** 实际生效的表前缀 */
  table_prefix: string;
  /** 本次应用的迁移条数 */
  applied: number;
  /** 账本里已记录、本次跳过的条数 */
  skipped: number;
  /** 每条迁移的结果（applied / skipped / error） */
  migrations: MigrationResult[];
}

/**
 * 库中已按其他前缀初始化 —— 继续迁移会让应用悄悄切到另一套（通常是空的）表上。
 * 调用方（routes）把它翻成 409 并在响应里说明如何修正 TABLE_PREFIX。
 */
export class TablePrefixConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TablePrefixConflictError";
  }
}

/**
 * 本应用独有的表后缀：共享 D1 里其他项目（`eNotify_*`、`SL_*`、`ZETA_*`、`nav_*`）没有这几张表，
 * 因此「同前缀下三者齐全」= post 的一套 schema。绝不用单表匹配（`users` 这种表名不唯一）。
 */
const POST_UNIQUE_SUFFIXES = ["letters", "letter_recipients", "user_2fa"] as const;

/** post 的默认前缀核（`post_` → `post`），用于把账本表名归属到本应用。 */
const POST_DEFAULT_CORE = prefixCore(DEFAULT_TABLE_PREFIX);

/** 从库中表名里扫出所有 `_<前缀核>_schema_migrations` 形态的账本核。 */
function detectLedgerCores(names: string[]): Set<string> {
  const cores = new Set<string>();
  for (const n of names) {
    if (n === "_schema_migrations") {
      cores.add("");
      continue;
    }
    const m = /^_([A-Za-z0-9_]+)_schema_migrations$/.exec(n);
    if (m !== null && m[1] !== undefined) cores.add(m[1]);
  }
  return cores;
}

/** 业务表族扫描：按「前缀核 → 命中的后缀集合」归组，返回三张独有表齐全的核。 */
function detectTableFamilyCores(names: string[]): Set<string> {
  const byCore = new Map<string, Set<string>>();
  for (const n of names) {
    for (const suffix of POST_UNIQUE_SUFFIXES) {
      if (!n.endsWith(suffix)) continue;
      const core = prefixCore(n.slice(0, n.length - suffix.length));
      let suffixes = byCore.get(core);
      if (suffixes === undefined) {
        suffixes = new Set<string>();
        byCore.set(core, suffixes);
      }
      suffixes.add(suffix);
    }
  }

  const cores = new Set<string>();
  for (const [core, suffixes] of byCore) {
    if (POST_UNIQUE_SUFFIXES.every((s) => suffixes.has(s))) cores.add(core);
  }
  return cores;
}

/**
 * 只读探测：库是否已在**其他前缀**下初始化。返回人话描述（冲突）或 null（可以迁移）。
 *
 * 两路信号（对齐 ONE-347 冻结契约）：
 * - 业务表族：post 独有的三张表在同一前缀下齐全（无歧义）；
 * - 账本表：`_<前缀核>_schema_migrations` 存在，但账本形态对共享库里**所有**项目都成立，
 *   单看表名无法归属 → 只有当该核能归属到 post（等于默认核 `post`，或该核下存在
 *   post 独有业务表）时才算冲突信号。否则 shortlink / Zeta 转账本后它们的
 *   `_SL_schema_migrations` / `_ZETA_schema_migrations` 会把 post 的 setup 误杀。
 */
async function detectTablePrefixConflict(
  db: Pick<Env, "DB">["DB"],
  prefix: string,
): Promise<string | null> {
  const { results } = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all<{ name: string }>();
  const names = results.map((r) => r.name);

  const core = prefixCore(prefix);

  // 本前缀的账本表已在 → 这是增量迁移，不是静默切换，放行。
  if (names.includes(migrationsTable(prefix))) return null;

  const tableCores = detectTableFamilyCores(names);
  const ledgerCores = detectLedgerCores(names);

  const others = new Set<string>();
  for (const c of tableCores) {
    if (c !== core) others.add(c);
  }
  for (const c of ledgerCores) {
    if (c === core) continue;
    if (c === POST_DEFAULT_CORE || tableCores.has(c)) others.add(c);
  }
  if (others.size === 0) return null;

  const described = [...others]
    .sort()
    .map((c) => (c === "" ? "无前缀 schema" : `${c}_*`))
    .join("、");
  const resolved = prefix === "" ? "空串（无前缀）" : `"${prefix}"`;
  const hint = others.has("")
    ? "既有 schema 无前缀时请显式配置 TABLE_PREFIX=''"
    : `请把 TABLE_PREFIX 配成既有 schema 的前缀（如 TABLE_PREFIX='${[...others]
        .sort()
        .find((c) => c !== "")}_'）`;

  return (
    `数据库里已有一套 post schema（${described}），但当前 TABLE_PREFIX 解析为 ${resolved}。` +
    `拒绝按新前缀另建一套表、把应用悄悄切到空库。若沿用既有 schema，${hint}；` +
    `确实要从零重建，请先由用户按合并关口清单删掉本项目旧表。`
  );
}

// D1 的 exec() 只处理多行字符串的第一行：去掉 SQL 行注释并把所有空白压成一行。
function toSingleLine(sql: string): string {
  return sql
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 执行迁移：空库首跑全部 applied，之后只跑账本里缺的项。
 *
 * @param migrationsOverride 仅供单测做失败注入；生产路径一律用 db/migrations.ts 的列表。
 */
export async function runMigrations(
  env: Pick<Env, "DB" | "TABLE_PREFIX">,
  migrationsOverride?: Migration[],
): Promise<RunMigrationsResult> {
  const prefix = getTablePrefix(env);

  // 防静默切换（最高优先级）：绝不能按与库中既有 schema 不同的前缀再建一套。
  const conflict = await detectTablePrefixConflict(env.DB, prefix);
  if (conflict !== null) throw new TablePrefixConflictError(conflict);

  const historyTable = migrationsTable(prefix);

  // 用 prepare().run() 执行单条 DDL —— 避开 exec() 的多行限制。
  await env.DB.prepare(createMigrationsTableSql(prefix)).run();

  const { results } = await env.DB.prepare(
    `SELECT name FROM ${historyTable}`,
  ).all<{ name: string }>();
  const applied = new Set(results.map((r) => r.name));

  const migrations: MigrationResult[] = [];

  for (const migration of migrationsOverride ?? getMigrations(prefix)) {
    if (applied.has(migration.name)) {
      migrations.push({ name: migration.name, status: "skipped" });
      continue;
    }
    try {
      await env.DB.exec(toSingleLine(migration.sql));
      await env.DB.prepare(`INSERT INTO ${historyTable} (name) VALUES (?)`)
        .bind(migration.name)
        .run();
      migrations.push({ name: migration.name, status: "applied" });
    } catch (err) {
      // 失败项不落账：账本保持原样，修好后重跑会重试它。
      migrations.push({
        name: migration.name,
        status: "error",
        error: String(err),
      });
      break;
    }
  }

  return { prefix, migrations };
}

/** runner 结果 → 两个 setup 入口共用的响应摘要。 */
export function toSchemaReport(result: RunMigrationsResult): SchemaReport {
  return {
    table_prefix: result.prefix,
    applied: result.migrations.filter((m) => m.status === "applied").length,
    skipped: result.migrations.filter((m) => m.status === "skipped").length,
    migrations: result.migrations,
  };
}

/** 首条 error 结果（没有失败时 null），供 routes 决定是否关闭 setup / 返回 500。 */
export function firstMigrationError(
  result: RunMigrationsResult,
): MigrationResult | null {
  return result.migrations.find((m) => m.status === "error") ?? null;
}
