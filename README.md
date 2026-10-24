# 时光邮局（post）

在未来某个日期时间，把一封信通过邮件寄到指定邮箱 —— 小圈子多用户的定时寄信服务。线上域名：post.oneboy.app。

## 技术栈

- monorepo：pnpm workspace，`web/` + `worker/`
- `web/`（`@post/web`）：React + Vite + TypeScript，构建产物由 Workers Static Assets 托管
- `worker/`（`@post/worker`）：Hono + Cloudflare Workers，D1 数据库，cron 定时调度（`*/5 * * * *`）

## 本地开发

```bash
pnpm install

# 同时启动 worker（:8787）与 web（Vite dev server，/api 代理到 :8787）
pnpm dev

# 仅启动一侧
pnpm dev:worker
pnpm dev:web
```

Worker 本地首次运行会提示创建本地 D1；需要绑定真实 D1 时在 `worker/` 下用 `wrangler` 登录后配置（见 `worker/wrangler.toml`）。

## 校验命令（CI 同款）

```bash
pnpm typecheck   # web + worker 类型检查
pnpm build       # web 构建 + worker 类型检查构建
pnpm test        # worker 单测（vitest）
```

## 部署

合并到 `main` 且 CI 通过后，`Deploy` workflow 自动构建 `web/` 并 `wrangler deploy`。合并即自动部署上线，**合并关口归用户**。

部署所需配置（未配置时 workflow 会失败，见下）：

- Repository secret：`CLOUDFLARE_API_TOKEN`（Workers/D1 部署权限）
- Repository variables：`CLOUDFLARE_ACCOUNT_ID`、`D1_DATABASE_NAME`、`D1_DATABASE_ID`

本地手动部署：`pnpm deploy`（内部替换 wrangler.toml 占位符后 `wrangler deploy`）。域名 `post.oneboy.app` 的绑定在部署阶段处理。

## 目录结构

```
web/      前端（@post/web）
worker/   Cloudflare Worker（@post/worker，Hono + D1 + cron）
scripts/  部署辅助脚本
```
