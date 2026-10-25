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
- `SETUP_SECRET`：初始化 setup 页所需的密钥（`POST /api/setup` 请求体 `{ setup_secret }`）
- `TABLE_PREFIX`（可选，非 secret）：表名前缀，见下“表前缀”小节

两个密钥均至少 16 字符；未配置/过短/占位符时 fail-safe 拒绝全部 `/api/*`（500 `Server misconfigured`）。密钥不进 `wrangler.toml [vars]`：本地走 `.dev.vars`，线上走 `wrangler secret put`。

### 表前缀（TABLE_PREFIX）

post 使用组织共享 D1，表名一律带前缀（ONE-269）。三态解析：

- 未配置（`undefined`）→ 默认 `post_`（共享 D1 零配置隔离，安全默认）；
- 显式空串 `""` → 无前缀（部署方自担表名冲突风险）；
- 其他值 → 须匹配 `/^[a-z0-9_]*$/`，否则启动报错；合法则原样使用（不自动补下划线，需自带尾部 `_`）。

本地覆盖：在 `worker/.dev.vars` 加 `TABLE_PREFIX=my_`；线上：GitHub Variable `TABLE_PREFIX` 经 Deploy workflow 注入 `[vars]`。

**建表统一在运行时**：`POST /api/setup` 完成初始化时，由 `ensureSchema` 按生效前缀替换 `{prefix}` 后内联建表（幂等）。已无独立静态迁移文件。

**初始化后改前缀不支持**：表名一旦落库即固定，改 `TABLE_PREFIX` 会指向全新一套空表（不会自动迁移切换）。上线前定好前缀。

### 账号体系（stage 2）

- 首次部署（ONE-313）：`GET /api/setup/state` → `{enabled:true}`；`POST /api/setup` 只提交 `{ setup_secret }`（请求体，用 `safeEqual` 与 Worker secret 比对；不符 403 `Invalid setup secret`，密钥未配置/占位符 500 `Server misconfigured`）即完成初始化，**不建任何账号**，返回 `{success:true}` 且 setup 关闭。
- 首个账号：初始化完成后，第一个走页面 `POST /api/auth/register` 的账号即 `role=admin, approval_status=approved`，可直接登录；此后注册一律 `role=user, approval_status=pending`（setup 未完成时注册返回 403 `Setup required before registration`）。
- 注册：`POST /api/auth/register` 开放，但新账号默认 `approval_status=pending`，登录被拒；管理员 `PUT /api/admin/users/:id/approve` 批准后才能登录。
- 登录：密码 + 可选 TOTP/Passkey 二步验证；会话为 HttpOnly Cookie（access 24h / refresh 7d，SameSite=Strict）。
- 用户自服务：`/api/me`（昵称/时区/语言、改密码、会话管理）；管理员：`/api/admin/users`（批准/禁用/角色）。

### 管理后台维护接口（ONE-319）

- `POST /api/admin/db-upgrade`（管理员会话）：程序升级后免 `SETUP_SECRET` 升级数据库。执行与初始化同一份 `ensureSchema`（`CREATE TABLE/INDEX IF NOT EXISTS`，幂等、不改数据），返回 `{success:true, table_prefix, statements}`；可重复调用。
- `GET /api/admin/setup-switch`（管理员会话）→ `{enabled:boolean}`；`POST /api/admin/setup-switch`（管理员会话，body `{enabled:boolean}`）→ `{success:true, enabled}`。开关与 SMTP 配置同库存放：`{prefix}system_settings` 的 `setup_page_switch` 键（无新表/新键，无需迁移），默认 ON。
- 开关 OFF 后 `GET /api/setup/state` 一律 404（浏览器访问 setup 页即 404）；ON 时恢复既有 `isSetupAvailable` 判定（`setup_page_enabled` 初始化标记 + 账号数为 0）。两者是不同的键：`setup_page_enabled` 由 `POST /api/setup` 写死，管理后台只改 `setup_page_switch`。

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
- Repository variables：`CLOUDFLARE_ACCOUNT_ID`、`D1_DATABASE_NAME`、`D1_DATABASE_ID`、`KV_NAMESPACE_ID`；可选 `TABLE_PREFIX`（表前缀，未配置时默认 `post_`）
- Worker secrets（部署后执行一次）：`wrangler secret put JWT_SECRET`、`wrangler secret put SETUP_SECRET`
- 首次部署建表：`POST /api/setup` 自动按生效前缀内联建表（无需 `wrangler d1 migrations apply`）

本地手动部署：`pnpm deploy`（内部替换 wrangler.toml 占位符后 `wrangler deploy`）。域名 `post.oneboy.app` 的绑定在部署阶段处理。

## 目录结构

```
web/      前端（@post/web）
worker/   Cloudflare Worker（@post/worker，Hono + D1 + KV + cron）
scripts/  部署辅助脚本
```
