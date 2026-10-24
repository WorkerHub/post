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

### Worker 本地环境变量

复制模板后按需修改（`.dev.vars` 已被 gitignore，仅本地生效）：

```bash
cp worker/.dev.vars.example worker/.dev.vars
```

- `JWT_SECRET`：会话签名密钥
- `SETUP_SECRET`：首次部署创建管理员账号所需的密钥（`X-Setup-Secret` 请求头）

两个密钥均至少 16 字符；未配置/过短/占位符时 fail-safe 拒绝全部 `/api/*`（500 `Server misconfigured`）。密钥不进 `wrangler.toml [vars]`：本地走 `.dev.vars`，线上走 `wrangler secret put`。

### D1 迁移

首次本地运行前应用迁移（miniflare 本地库，不碰线上）：

```bash
cd worker
pnpm exec wrangler d1 migrations apply D1_DATABASE_NAME_PLACEHOLDER --local
```

全新部署也可不预先迁移：`POST /api/setup` 会在建管理员时内联建表（幂等，与迁移文件同一份 schema，`worker/test/schema.test.ts` 保证两者一致）。

线上库迁移（需用户批准后执行）：`wrangler d1 migrations apply <database_name> --remote`。

### 账号体系（stage 2）

- 首次部署：`GET /api/setup/state` → `{enabled:true}`；`POST /api/setup`（`X-Setup-Secret` 头 + email/password）创建第一个账号，即管理员；创建后 setup 关闭，开放注册永不产生管理员。
- 注册：`POST /api/auth/register` 开放，但新账号默认 `approval_status=pending`，登录被拒；管理员 `PUT /api/admin/users/:id/approve` 批准后才能登录。
- 登录：密码 + 可选 TOTP/Passkey 二步验证；会话为 HttpOnly Cookie（access 24h / refresh 7d，SameSite=Strict）。
- 用户自服务：`/api/me`（昵称/时区/语言、改密码、会话管理）；管理员：`/api/admin/users`（批准/禁用/角色）。

## 校验命令（CI 同款）

```bash
pnpm typecheck   # web + worker 类型检查
pnpm build       # web 构建 + worker 类型检查构建
pnpm test        # worker 单测（vitest）
```

## 部署

合并到 `main` 且 CI 通过后，`Deploy` workflow 自动构建 `web/` 并 `wrangler deploy`。合并即自动部署上线，**合并关口归用户**。

部署所需配置（未配置时 workflow 会失败，见下）：

- Repository secret：`CLOUDFLARE_API_TOKEN`（Workers/D1/KV 部署权限）
- Repository variables：`CLOUDFLARE_ACCOUNT_ID`、`D1_DATABASE_NAME`、`D1_DATABASE_ID`、`KV_NAMESPACE_ID`
- Worker secrets（部署后执行一次）：`wrangler secret put JWT_SECRET`、`wrangler secret put SETUP_SECRET`
- 线上 D1 迁移：首次部署后执行 `wrangler d1 migrations apply <database_name> --remote`（对线上库的写操作需用户拍板）

本地手动部署：`pnpm deploy`（内部替换 wrangler.toml 占位符后 `wrangler deploy`）。域名 `post.oneboy.app` 的绑定在部署阶段处理。

## 目录结构

```
web/      前端（@post/web）
worker/   Cloudflare Worker（@post/worker，Hono + D1 + KV + cron）
  migrations/   D1 迁移（与 src/db/schema.ts 同步）
scripts/  部署辅助脚本
```
