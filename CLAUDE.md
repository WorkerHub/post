# CLAUDE.md

给在本仓库里干活的 AI agent / 协作者的项目须知。产品与部署细节见 `README.md`，此处只列容易踩坑的约定。

## 仓库结构

- pnpm workspace：`web/`（React + Vite，构建产物由 Workers Static Assets 托管）+ `worker/`（Hono on Cloudflare Workers，D1 + KV + cron）。
- `worker/src/routes/` HTTP 路由；`worker/src/db/` schema 迁移与查询；`worker/src/services/` 业务服务（SMTP、cron 调度）。
- 测试：`worker/test/`（vitest + `node:sqlite` 内存库替身，见 `worker/test/helpers.ts`）、`web/src/**/*.test.tsx`。

## 数据库迁移账本（ONE-347，对齐 shortlink）

schema 的**唯一**可信源是 `worker/src/db/migrations.ts` 的迁移列表（按前缀参数化）。

| 项 | 规则 |
| --- | --- |
| 账本表名 | `_` + 前缀核 + `_schema_migrations`；空前缀为 `_schema_migrations` |
| 前缀核 | 业务表前缀去掉尾部下划线（`post_` → `post`），大小写原值保留、不规范化 |
| 默认结果 | `_post_schema_migrations` |
| 生成入口 | 只经 `worker/src/types.ts` 的 `migrationsTable(prefix)`，严禁散落拼接 |
| 执行入口 | `worker/src/lib/migrations-runner.ts` 的 `runMigrations()`，`POST /api/setup` 与 `POST /api/admin/db-upgrade` 共用，不得双份维护 |

- **历史已塌缩**：post 无生产数据，只有一条 `schema_v1` = 当前最终 schema（6 表 + 4 索引），没有逐级历史、没有 baseline 播种。
- **写迁移的规则**：已合并的迁移名字与 SQL **不可修改**；只能在列表末尾追加 `schema_v2`、`schema_v3`…；迁移只增不毁（只加表 / 索引 / 列，不删、不改名、不重写存量数据），破坏性变更须另行立规格。
- **不要**恢复 `PRAGMA table_info` 探测式升级代码，也不要再引入第二份建表 SQL（`worker/src/db/schema.ts` 已删除）。
- 迁移数组的 SQL 会被 runner 压成单行后交给 D1 `exec()` 执行（D1 的 exec 只处理第一行），行注释 `--` 会被剥离。

## 校验命令（CI 同款）

```bash
pnpm typecheck   # web + worker
pnpm build       # web 构建 + worker 类型检查
pnpm test        # web + worker 单测
```

## 红线

- 密钥（`JWT_SECRET` / `SETUP_SECRET` / SMTP 密码）只从环境变量或 wrangler secret 读，绝不硬编码、不进日志与评论。
- 线上是组织**共享 D1**：任何 DDL / 数据操作只能碰本项目生效前缀（默认 `post_`）的表，严禁整库删除或动 `eNotify_*`、`SL_*`、`ZETA_*`、`nav_*`。
- 线上 D1 的删表 / 重初始化由用户在合并关口执行，agent 只提供清单，不直接操作。
- 合并与部署上线归用户，不自行合并 PR、不自行部署。
