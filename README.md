# 时光邮局（someday）

在未来某个日期时间，把一封信通过邮件寄到指定邮箱 —— 小圈子多用户的定时寄信服务。线上域名：someday.oneboy.app。

## 技术栈

- monorepo：pnpm workspace，`web/` + `worker/`
- `web/`（`@someday/web`）：React + Vite + TypeScript，构建产物由 Workers Static Assets 托管
- `worker/`（`@someday/worker`）：Hono + Cloudflare Workers，D1 数据库，cron 定时调度（`*/5 * * * *`）

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

someday 使用组织共享 D1，表名一律带前缀（ONE-269）。三态解析：

- 未配置（`undefined`）→ 默认 `post_`（共享 D1 零配置隔离，安全默认）；
- 显式空串 `""` → 无前缀（部署方自担表名冲突风险）；
- 其他值 → 须匹配 `/^[a-z0-9_]*$/`，否则启动报错；合法则原样使用（不自动补下划线，需自带尾部 `_`）。

本地覆盖：在 `worker/.dev.vars` 加 `TABLE_PREFIX=my_`；线上：GitHub Variable `TABLE_PREFIX` 经 Deploy workflow 注入 `[vars]`。

**建表统一在运行时、走迁移账本（ONE-347）**：`POST /api/setup` 与 `POST /api/admin/db-upgrade`
共用 `worker/src/lib/migrations-runner.ts` 的 `runMigrations()`，按生效前缀把
`worker/src/db/migrations.ts` 的迁移列表落到账本表里（幂等）。不再有独立静态迁移文件，
也没有第二份建表定义——详见下“数据库迁移账本”小节。

**初始化后改前缀不支持**：表名一旦落库即固定，改 `TABLE_PREFIX` 会指向全新一套空表；
runner 探测到库已在其他前缀下初始化时会**直接中止报错**（不会静默另建一套）。上线前定好前缀。

### 数据库迁移账本（ONE-347，对齐 shortlink）

schema 的唯一可信源是 `worker/src/db/migrations.ts` 里按前缀参数化的迁移列表：

| 项 | 公式 / 取值 |
| --- | --- |
| 账本表名 | `_` + 「前缀核」+ `_schema_migrations`，空前缀时为 `_schema_migrations` |
| 前缀核 | 业务表前缀去掉尾部下划线：`post_` → `post`（大小写原值保留，不规范化） |
| 默认结果 | `_post_schema_migrations` |
| 表名生成入口 | 只经 `worker/src/types.ts` 的 `migrationsTable(prefix)` 一处生成，严禁散落拼接 |
| 账本结构 | `name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL DEFAULT (unixepoch())` |

**历史已塌缩**：someday 无生产数据，历史不逐级展开，`schema_v1` = 业务 schema 基线
（6 表 + 4 索引）。`schema_v2` 起为增量迁移：

| 迁移 | 内容 |
| --- | --- |
| `schema_v2` | `{prefix}waker_executions`（waker 回调的执行幂等账本，见下“waker 回调入口”） |
| `schema_v3` | `letters.next_attempt_at`（限流退避的下次可尝试时刻） |
| `schema_v4` | `letters.throttle_attempts`（限流计数器，不占用 `attempts`） |
| `schema_v5` | `letter_recipients.message_id`（每收件人副本的 Message-ID） |
| `schema_v6` | 索引 `(status, next_attempt_at, send_at)`（到期扫描的退避过滤） |

`schema_v3`–`v6` 每条**只含一条 DDL**：账本只在整条迁移成功后落账、失败项重跑会重放整条 SQL，
而 `ALTER TABLE ADD COLUMN` 本身不幂等——单语句拆分才能保证重跑只重试失败的那一条。

**runner 语义**（`worker/src/lib/migrations-runner.ts`，两处 setup 入口共用）：

1. 按 TABLE_PREFIX 三态解析生效前缀；
2. 防静默切换：库里已按其他前缀初始化时中止报错（信号两路：someday 独有三表齐全的业务表族，
   以及可归属到 someday 的账本表 `_<前缀核>_schema_migrations`）；共享库里 shortlink / Zeta
   等其他项目的账本表不会被误判；
3. 建账本表（`IF NOT EXISTS`）→ 读已应用集合 → 按序执行未记录的迁移，成功后立即写一行；
4. 首个失败即停、报错，**失败项不落账**（修好后重跑会重试它）。

**今后写迁移的规则**：

- 已合并的迁移，**名字与 SQL 都不可修改**（账本按名字记录，改历史会让已部署的库与代码悄悄不一致）；
- 只能在本数组**末尾追加** `schema_v2`、`schema_v3`…；
- 迁移**只增不毁**：只加表 / 索引 / 列，不删表、不改名、不重写存量数据；破坏性变更须另行立规格
  （重初始化由用户在合并关口执行，团队不碰线上 D1）；
- 不新增任何 `PRAGMA table_info` 探测式升级代码。

**默认 settings 种子**：someday 没有默认 settings 种子数据（`{prefix}system_settings` 的键都由
业务按需写入），因此没有种子迁移；`setup` 的后置步骤仍是老的两件事——`schema_v1` 落库后
由 `closeSetup()` 写 `setup_page_enabled=0`，再由第一个注册用户成为管理员。

### 账号体系（stage 2）

- 首次部署（ONE-313）：`GET /api/setup/state` → `{enabled:true}`；`POST /api/setup` 只提交 `{ setup_secret }`（请求体，用 `safeEqual` 与 Worker secret 比对；不符 403 `Invalid setup secret`，密钥未配置/占位符 500 `Server misconfigured`）即完成初始化，**不建任何账号**，返回 `{success:true, table_prefix, applied, skipped, migrations:[{name,status}]}`（旧调用方只判断 HTTP 200，新增字段向后兼容）且 setup 关闭。前缀冲突返回 409，迁移失败返回 500 且 setup 保持开启。
- 首个账号：初始化完成后，第一个走页面 `POST /api/auth/register` 的账号即 `role=admin, approval_status=approved`，可直接登录；此后注册一律 `role=user, approval_status=pending`（setup 未完成时注册返回 403 `Setup required before registration`）。
- 注册：`POST /api/auth/register` 开放，但新账号默认 `approval_status=pending`，登录被拒；管理员 `PUT /api/admin/users/:id/approve` 批准后才能登录。
- 登录：密码 + 可选 TOTP/Passkey 二步验证；会话为 HttpOnly Cookie（access 24h / refresh 7d，SameSite=Strict）。
- 用户自服务：`/api/me`（昵称/时区/语言、改密码、会话管理）；管理员：`/api/admin/users`（批准/禁用/角色）。

### 管理后台维护接口（ONE-319）

- `POST /api/admin/db-upgrade`（管理员会话）：程序升级后免 `SETUP_SECRET` 升级数据库。执行与初始化**同一个迁移 runner**（ONE-347；只跑账本里缺的迁移、不删不改存量数据），返回 `{success:true, table_prefix, applied, skipped, migrations:[{name,status}]}`；可重复调用。迁移失败时返回 500 `{success:false, error:"Migration failed: <name>", ...}`，失败项不落账。
- `GET /api/admin/setup-switch`（管理员会话）→ `{enabled:boolean}`；`POST /api/admin/setup-switch`（管理员会话，body `{enabled:boolean}`）→ `{success:true, enabled}`。开关与 SMTP 配置同库存放：`{prefix}system_settings` 的 `setup_page_switch` 键（无新表/新键，无需迁移），默认 ON。
- 开关 OFF 后 `GET /api/setup/state` 一律 404（浏览器访问 setup 页即 404）；ON 时恢复既有 `isSetupAvailable` 判定（`setup_page_enabled` 初始化标记 + 账号数为 0）。两者是不同的键：`setup_page_enabled` 由 `POST /api/setup` 写死，管理后台只改 `setup_page_switch`。

### waker 回调入口（ONE-566）

定时投递的触发源可由 waker 平台回调驱动（试点期与自有 cron 双跑，cron 仍保留）：

| 项 | 值 |
| --- | --- |
| 回调地址 | `https://someday.oneboy.app/_waker/execute`（SDK 的 `CALLBACK_MOUNT_PATH` + `/execute`） |
| 任务名 | `deliver-due-letters`（`worker/src/services/waker-callback.ts` 的 `DUE_LETTERS_JOB`，须与 waker 平台里注册的 job 名逐字一致） |
| 验签 | HMAC-SHA256 覆盖 `timestamp + executionId + jobId + rawBody`，300s 时间窗，由 SDK receiver 完成；未带签名/篡改/过期 → 401，缺 signing key → 500（fail closed） |
| 执行语义 | handler `await processDueLetters(env, { timeoutSeconds })` 跑完才回 2xx，响应体带 `{ stats }`（`scanned` / `claimed` / `delivered` / `partialFailed` / `failed` / `throttled` / `deferred_by_cap` / `paused_until`，口径同 `processDueLetters`）；抛错/DB 不可用 → 5xx，平台重试 |
| 单轮预算 | 预算取自回调体 `timeoutSeconds`（waker 任务策略，现配置 120 秒），留 10 秒收尾余量；预算或单轮收件人上限用尽即顺延到下一轮，本轮首封必发 |
| 幂等 | executionId 由 SDK 的 D1 账本去重（`{prefix}waker_executions`，`schema_v2`），重复投递回 2xx + `duplicate:true` + 首响应回放；业务防重仍是 letters 状态抢占（最终防线，未改） |

SDK 是**源码拷贝**（`worker/src/waker/`，来源与版本见该目录 `README.md`），不手改；升级回 waker 仓库改完再整目录重拷。
签名密钥 `WAKER_SIGNING_KEY` 只走 secrets：线上配 GitHub repository secret，Deploy workflow 写进 `--secrets-file` 注入；本地放 `worker/.dev.vars`（自生成的测试 key）。

**上线先后**：部署后需由管理员跑一次 `POST /api/admin/db-upgrade` 应用未落账的迁移（`schema_v2` 新建 `{prefix}waker_executions`；`schema_v3`–`v6` 为发信节流补的新列与索引）。**未跑之前投递扫描会因缺列报错、回调回 5xx**，所以部署后第一件事就是跑一次升级。

### 发信节流（THROTTLING-ADDENDUM §3）

waker 每 5 分钟回调一次，节流把「一轮爆发」摊成「多轮细流」，参数与运行状态都在
`{prefix}system_settings`：

| 键 | 内容 |
| --- | --- |
| `send_throttle_config` | JSON：`interval_ms`（默认 4000，0–30000）、`jitter_ms`（默认 2000，0–10000）、`max_recipients_per_run`（默认 10，1–100）。缺失/字段缺失逐项回默认；非法值回默认并 warn（投递不崩） |
| `send_paused_until` | 熔断截止时刻（UTC ISO）；未过期时触发的扫描直接跳过发送、不抢占任何信 |

- **间隔 + 单轮上限**：逐收件人串行，本轮第一封不等待，其后每封前等 `interval_ms + random(0, jitter_ms)`（运行时原生 `setTimeout`）；单轮最多处理 `max_recipients_per_run` 个收件人，额度在**抢占之前**生效。信只发了一部分时未发收件人保持 `pending`、信回 `scheduled`（`attempts` 与 `last_error` 不动），绝不卡在 `sending`。
- **限流退避**：SMTP 回复码 421/450/451/452 或命中限流关键词 → 收件人记 `[throttle:452] ...`、信 `attempts` 不增加、`throttle_attempts+1`、`next_attempt_at` 按 15 → 30 → 60 分钟递增（封顶 60）；退避时刻超过 `send_at + 24h` 直接置 `failed`。第一例限流即停掉本轮剩余发送并写 `send_paused_until`（只由限流类触发）。
- **永久错误**（550/551/553 等）走原路径：计 `attempts`、达 3 次置 `failed`，不熔断。
- **成功即清零**：整封发完置 `sent` 并清 `next_attempt_at` / `throttle_attempts`；`POST /api/letters/:id/resend` 也一并清空。
- **防去重**：每收件人副本一个 Message-ID `<sr.{letter_id}.{recipient_id}.{随机串}@{From 域名}>`（成功后落 `letter_recipients.message_id`），邮件头带 `X-Someday-Letter-Id`，落款追加「信件编号：{letter_id}」。
- **参数接口**：`GET/PUT /api/admin/settings/send-throttle`（管理员会话，v1 无设置页 UI；PUT 越界/非整数 400，未提供的字段保持当前值）。管理员「发送测试邮件」不走队列，不受上限、间隔与 `send_paused_until` 影响。

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
- 可选 secret：`WAKER_SIGNING_KEY`（waker 项目回调验签密钥，ONE-566）。未配置时 `/_waker/execute` fail closed 回 500，其余路由不受影响；建好 waker 项目拿到一次性 signing key 后配上并重新部署即可
- 首次部署建表：`POST /api/setup` 自动按生效前缀内联建表（无需 `wrangler d1 migrations apply`）

本地手动部署：`pnpm deploy`（内部替换 wrangler.toml 占位符后 `wrangler deploy`）。域名 `someday.oneboy.app` 的绑定在部署阶段处理。

## 目录结构

```
web/      前端（@someday/web）
worker/   Cloudflare Worker（@someday/worker，Hono + D1 + KV + cron）
scripts/  部署辅助脚本
```
