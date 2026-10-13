# RoboBrowser

可视化网页自动化桌面软件 + 无头服务器。同一份 `FlowModel`（JSON）既能被
Electron 桌面宿主编排器运行，也能在无桌面的 Linux 服务器上由 worker 进程运行，
两者共用 `@robrowser/core` 的引擎与 `@robrowser/browser` 的 CDP 适配层。

- 自动化以 **CDP 直连为主 + 页面 JS 注入为辅**（不使用 Selenium/Puppeteer 语义层）。
- 流程可视化编排（React Flow 节点图），可一键导出为 **Playwright** 或 **裸 CDP** 脚本；
  导出脚本也能反向导入，重新得到可编辑的流程。
- 遇到验证码/人机检测时支持 **远程人工接管**：另一台电脑打开接管页面即可看到实时画面
  并用鼠标键盘操作服务器上的浏览器，处理完成后流程自动恢复。

## 目录结构

```
robrowser/
├── docker/                       # 服务器镜像 + compose
├── fixtures/                     # 本地 HTML fixture（测试与示例流程使用）
├── flows/demo.json               # 可运行的示例流程
├── packages/
│   ├── core/                     # FlowModel schema、引擎、步骤、导出器/导入器、存储抽象
│   ├── browser/                  # CDPSession、remote/electron 适配层、screencast、input、metrics
│   ├── desktop/                  # Electron 主进程 + preload + React 渲染进程
│   └── server/                   # CLI、Fastify REST/WS、SQLite 队列、worker、远程接管
├── package.json                  # pnpm workspaces + 脚本
├── pnpm-workspace.yaml
└── tsconfig.base.json
```

`core` 与 `browser` 是纯 Node/TypeScript 包：禁止 import `electron` / `react` /
`express` / `fastify`。依赖方向永远是 `desktop` / `server` → `browser` → `core`。

## 环境要求

| 组件              | 版本           | 说明                                                           |
| ----------------- | -------------- | -------------------------------------------------------------- |
| Node.js           | **20+**        | 使用 ES2022、`AbortSignal`、原生 `fetch`                       |
| pnpm              | 9+             | 仓库用 `packageManager` 固定为 `pnpm@9.12.0`                   |
| Chromium / Chrome | 任意近两年版本 | 桌面端用 Electron 内置；服务器端用系统 Chromium                |
| 构建工具          | 可选           | `better-sqlite3` 优先使用预编译二进制，通常无需 VS Build Tools |

## 快速开始

```bash
pnpm install
pnpm build
pnpm test
```

端到端跑通示例流程（登录 → 仪表盘 → 分支 → 提取 → 截图）：

```bash
node packages/server/dist/cli.js validate flows/demo.json
node packages/server/dist/cli.js run flows/demo.json --headless
```

Windows PowerShell 如需指定浏览器：

```powershell
$env:CHROME_PATH = "C:\Program Files\Google\Chrome\Application\chrome.exe"
node packages\server\dist\cli.js run flows\demo.json --headless --out run\demo
```

`automate run` 会在 stdout 输出结构化 JSON 摘要（步骤数、耗时、产物路径、结果），
可直接被 CI 消费；诊断日志走 stderr 的 pino。

## 桌面应用

```bash
# 开发：Vite 渲染进程 + tsc 主进程 + Electron 一起启动
pnpm --filter @robrowser/desktop dev

# 只启动渲染进程（调试 UI 用）
pnpm --filter @robrowser/desktop dev:renderer

# 构建（主进程 tsc + 渲染进程 Vite）
pnpm build

# 打包安装包（electron-builder）
pnpm --filter @robrowser/desktop package
```

开发脚本会把 `VITE_DEV_SERVER_URL=http://127.0.0.1:5273` 传给 Electron；
主进程据此选择 `loadURL`（开发）或 `loadFile(dist/renderer/index.html)`（打包后）。

界面结构：

- 左侧 **FlowEditor**（React Flow 节点图）与 **StepConfigPanel** / **VariablePanel**；
- 右侧 **BrowserPreview**：真正的 `WebContentsView`，由主进程用绝对像素定位，
  与渲染进程 CSS 的布局常量一一对应（`header 56px` / `preview-bar 40px` /
  `log 250px` / `inset 8px` / `left 38%`）。这两处常量必须同步修改；
- 下方 **RunLogPanel**：实时 `step:start` / `step:ok` / `step:fail` 事件流；
- **ExportDialog**：预览并保存 Playwright / raw-cdp 脚本；
- **ImportDialog**：粘贴或打开 Playwright / raw-cdp 脚本，还原为可编辑流程，
  并列出无法映射的语句；
- **凭据**：管理网页账号密码（详见 `网页账号密码（凭据库）` 一节）；
- `manual` 步骤弹出本地窗口，用户在内嵌浏览器里操作后点“完成并继续”。

关于原生视图与覆盖层（实现细节，修改布局时务必留意）：

- `WebContentsView` 由 Chromium 直接合成，**始终绘制在渲染进程 DOM 之上**，
  因此跨列的居中弹窗会被浏览器画面遮住。人工处理提示因此固定在左栏
  （`.rb-manual-backdrop`），右侧浏览器保持完全可交互——这恰好是 `manual`
  步骤需要的；导出/历史等不需要浏览器的覆盖层则通过
  `window.robrowser.setBrowserViewVisible(false)` 临时隐藏原生视图；
- “运行”按钮在 `bootstrap:ready` 之前保持禁用（渲染层同时调用
  `hostStatus()` 兜底，避免事件早于订阅而漏收）。CDP 只有在
  `WebContentsView` 完成一次导航、渲染进程创建之后才能 attach：
  否则 `Page.enable` 永不返回，控制器无法就绪；
- `manual` 步骤的“完成并继续”会先校验 `resolveWhen`（3 秒窗口）。
  条件未满足时主进程返回 `{ok:false, reason:"predicate-pending"}`，
  弹窗保持打开并提示原因，不会静默放行、也不会卡在“校验中…”。

渲染进程没有 Node 权限：`contextIsolation: true`、`nodeIntegration: false`，
所有能力经由 preload 暴露的最小 IPC API。流程与运行历史存在
`app.getPath('userData')` 下的 SQLite。

## 网页账号密码（凭据库）

流程文件（FlowModel JSON）里**只保存凭据名，不保存密码**，因此可以安全提交到仓库。
需要登录的步骤通过 `credential` 变量取值：

```jsonc
{
  "variables": {
    "login": { "type": "credential", "key": "github" },
  },
  "steps": [
    { "id": "user", "type": "type", "selector": { "css": "#login" }, "value": "{{login.username}}" },
    { "id": "pass", "type": "type", "selector": { "css": "#password" }, "value": "{{login.password}}" },
  ],
}
```

- `key` 是凭据名，运行时到宿主的凭据库中查找，解析为 `{ username, password, url? }`；
- `credential` 与 `secret` 一样脱敏：运行摘要、checkpoint 与事件里都显示 `***`；
- 找不到凭据时抛出带变量名与位置的 `VARIABLE_UNDEFINED`，不会退化成空密码提交。

### 桌面端

左栏 **凭据** 面板用于新增 / 编辑 / 删除网页账号密码。密码由 Electron `safeStorage`
（Windows DPAPI、macOS Keychain、Linux libsecret）加密后写入
`app.getPath('userData')` 下的 SQLite，**明文只存在于主进程内存**：

- 编辑已有凭据时密码框留空表示“不修改”，界面永远不会把密码回填到 DOM；
- 系统凭据库不可用（例如 Linux 上缺 libsecret）时**拒绝保存密码**并给出提示，
  只允许保存用户名，不会静默降级成明文；
- 列表接口只返回用户名 / 站点 / 更新时间等元数据，不返回密码。

### 服务端

无头部署没有系统凭据库，改用 AES-256-GCM 加密的 JSON 文件：

| 变量                    | 说明                                            |
| ----------------------- | ----------------------------------------------- |
| `ROBO_CREDENTIALS_FILE` | 凭据文件路径，默认 `<RUN_DIR>/credentials.json` |
| `ROBO_CREDENTIALS_KEY`  | 加密密钥，未设置时回落到 `SECRET`               |

- 文件里只有密文（scrypt 派生密钥 + 随机 IV + GCM tag），单独泄露文件无法还原密码；
- 未配置任何密钥时**拒绝保存密码**，与桌面端行为一致；
- 写入经临时文件 + rename 原子落盘，并串行化读改写；
- 更换密钥后旧密文无法解密，会提示“重新保存密码”。

### 导出脚本里的凭据

导出的 Playwright / raw-cdp 脚本拿不到宿主凭据库，改为读取环境变量
`ROBO_CRED_<KEY>_USERNAME` / `ROBO_CRED_<KEY>_PASSWORD`（`<KEY>` 是凭据名大写、
非字母数字转下划线），脚本里不会出现密码：

```bash
export ROBO_CRED_GITHUB_USERNAME=alice
export ROBO_CRED_GITHUB_PASSWORD=...
node run/demo.cjs
```

导入脚本时，导出器写入的 `__roboCredential` 标记会把变量无损还原为 `credential`。

> **注意**：`secret` 变量的 `default` 是**明文写进流程 JSON** 的。要保存登录密码请用
> `credential`，不要把密码放进 `secret.default` 或 `const`。

## 服务器

### CLI

```bash
automate run      <flow.json> [--headless|--headful] [--chrome <path>] [--out <dir>] [--var k=v]
automate validate <flow.json>
automate export   <flow.json> --target playwright|raw-cdp [--out file]
automate import   <script.js> [--target playwright|raw-cdp] [--out flow.json]
automate serve    [--host <host>] [--port <port>]
```

`--var` 可重复；`--auto-manual` 让 `manual` 步骤立即通过（仅用于自动化测试）。

### HTTP + WebSocket

```bash
node packages/server/dist/cli.js serve --host 0.0.0.0 --port 8080
```

| 方法 | 路径                  | 说明                                                      |
| ---- | --------------------- | --------------------------------------------------------- |
| POST | `/runs`               | 提交流程：`{ flowId }` 或 `{ flow, vars? }`，返回 `runId` |
| GET  | `/runs/:id`           | 任务状态与运行结果                                        |
| GET  | `/runs`               | 列表，支持 `limit` / `offset` / `status` / `flowId`       |
| POST | `/runs/:id/cancel`    | 取消任务                                                  |
| WS   | `/runs/:id/events`    | 步骤事件流（订阅时先收到一次 `snapshot`）                 |
| GET  | `/healthz`            | 健康检查                                                  |
| POST | `/takeover/exchange`  | 用一次性 ticket 换短期 WS token                           |
| WS   | `/takeover/ws?token=` | 接管通道（画面下行 + 输入上行）                           |
| GET  | `/takeover/`          | 接管页面（静态 HTML + canvas）                            |

队列语义：任务落 SQLite，`MAX_CONCURRENCY` 控制并发 worker 进程数，每个任务在独立
子进程中执行（崩溃不影响服务端），`TASK_TIMEOUT_MS` 超时后中止，失败按
`TASK_RETRIES` 重试。

### 远程人工接管

1. 流程命中 `manual` 步骤 → `RemoteTakeoverHandler` 创建会话（状态 `PENDING`）；
2. 服务端签发一次性 JWT（含 `jti`/`sessionId`/`runId`/`stepId`，默认 10 分钟过期），
   通知渠道把接管 URL（`<PUBLIC_URL>/takeover/?ticket=...`）发给操作者；
3. 接管页面 `POST /takeover/exchange` 把 ticket 换成短期 WS token，随后立即
   `history.replaceState` 从地址栏移除 ticket，再连接 `/takeover/ws`；
4. **first-wins**：第一个客户端成为唯一操作者，后来的连接被 `4403` 拒绝；
5. 画面下行走 `Page.startScreencast`（jpeg，每帧强制 ack），输入上行走
   `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent` / `Input.insertText`；
6. 恢复条件**双重**：操作者点“完成，继续自动化”后服务端会先校验 `resolveWhen`
   （默认 3 秒窗口），同时后台每秒轮询一次，命中即自动恢复，即使人忘记点击。

客户端输入按到达顺序串行处理（每个 socket 一条 promise 链），因此在快速
`down → up → text` 或拖拽时不会出现 CDP 调用竞态。

**安全要求（生产环境必须满足）**

- 必须放在 **HTTPS/WSS** 后面（反向代理终止 TLS）。ticket 与画面都含敏感信息；
  内网部署至少要求 VPN 或双向 TLS。
- `SECRET` 必须替换为随机值（`openssl rand -hex 32`），它用于签发 ticket 与 WS token。
- 一次性 ticket 的已用 `jti` 列表是**进程内**的：多实例部署需要把 `TicketService`
  的 used/revoked 集合换成 Redis 之类的共享存储，否则重放防护只在单实例内有效。
- 接管会话被绑定到单个 page，无法触达其他 run；操作必须在 token 有效期内完成。
- 审计日志记录 who / when / runId / stepId / 时长 / 结果，级别为 `warn`。

### 通知渠道：飞书 / 钉钉 / 邮件 / Webhook

脚本跑不下去时必须有人知道，否则自动化会静默失败。RoboBrowser 内置五种渠道，
**同一套配置同时服务于「人机验证等人接管」与「运行失败」两类事件**：

| 渠道       | 触发方式                                      | 配置                                                 |
| ---------- | --------------------------------------------- | ---------------------------------------------------- |
| `feishu`   | 群机器人（interactive 卡片，按钮可直接点开接管页） | `FEISHU_WEBHOOK_URL` +（开启签名时）`FEISHU_SECRET`   |
| `dingtalk` | 群机器人（默认 markdown，可点击链接）         | `DINGTALK_WEBHOOK_URL` +（开启加签时）`DINGTALK_SECRET` |
| `email`    | `smtp://`（需 `nodemailer`）或 HTTP 邮件网关  | `SMTP_URL` + `NOTIFY_TO`                             |
| `webhook`  | 通用 HTTP JSON 回调（Slack / 企业微信 / n8n） | `WEBHOOK_URL`                                        |
| `log`      | 写日志，永远可用（兜底）                      | 无需配置                                             |

两类事件：

1. **需要人工接管**（`takeover`）：流程走到 `manual` 步骤（验证码、短信、扫脸…）时，
   把 `<PUBLIC_URL>/takeover/?ticket=...` 推给你，手机点一下就能远程操作；
2. **运行失败**（`run-failed`）：步骤报错、超时、被中止、worker 崩溃时推送失败原因、
   卡住的步骤与运行目录。由 `NOTIFY_ON_FAILURE`（默认 `true`）控制。

#### 飞书群机器人

1. 目标群 → 设置 → 群机器人 → 添加机器人 → **自定义机器人**；
2. 复制 Webhook 地址（`https://open.feishu.cn/open-apis/bot/v2/hook/xxx`）；
3. 建议开启 **签名校验** 并复制密钥，然后配置：

```bash
export FEISHU_WEBHOOK_URL="https://open.feishu.cn/open-apis/bot/v2/hook/xxx"
export FEISHU_SECRET="你的签名密钥"          # 未开启签名校验可不填
export NOTIFY_CHANNELS="feishu"             # 或写在 manual.notify 里
```

签名算法：`base64(HMAC-SHA256(key = "<timestamp>\n<secret>", data = ""))`，
`timestamp` 与 `sign` 作为 query 参数附加在 Webhook 地址上。

#### 钉钉群机器人

1. 目标群 → 群设置 → 智能群助手 → 添加机器人 → **自定义（Webhook）**；
2. 安全设置建议选 **加签**，复制以 `SEC` 开头的密钥；
3. 配置：

```bash
export DINGTALK_WEBHOOK_URL="https://oapi.dingtalk.com/robot/send?access_token=xxx"
export DINGTALK_SECRET="SECxxxx"            # 未开启加签可不填
export NOTIFY_CHANNELS="dingtalk"
```

签名算法：`base64(HMAC-SHA256(key = "SECxxx", data = "<timestamp>\nSECxxx")`，
同样以 `timestamp` / `sign` 查询参数附加。

> 钉钉机器人若用「自定义关键词」而非加签，请把关键词包含在消息里；
> 卡片标题固定为 `Manual takeover required (reason)` / `Run stopped and needs attention (reason)`。

#### 邮件

```bash
# 方式一：SMTP（需要安装可选依赖 nodemailer）
pnpm add -w nodemailer
export SMTP_URL="smtp://user:pass@smtp.example.com:587"
export NOTIFY_TO="ops@example.com"

# 方式二：HTTP 邮件网关 / 自建转发服务
export SMTP_URL="https://mail-gateway.example.com/send"
export NOTIFY_TO="ops@example.com"
```

#### 通用 Webhook

```bash
export WEBHOOK_URL="https://hooks.example.com/robrowser"
```

POST 的 JSON 里 `type` 为 `takeover.requested` 或 `run.failed`，`fields` 是可直接
渲染的 `key → value` 表，`text` 是排版好的纯文本（Slack / 企业微信 / n8n 可直接转发）。

#### 渠道的行为约定

- **只有失败与待接管才通知**：成功的 run 不发消息，不会被通知刷屏。
- **通知永远不会影响流程**：单个渠道报错只写日志，其余渠道照常发送，run 的状态
  与退出码不受影响。
- **未配置的渠道会明确报错**：在 `NOTIFY_CHANNELS` / `manual.notify` 里写了
  `feishu` 却没配 `FEISHU_WEBHOOK_URL` 时，启动日志会给出 `missing` 警告，
  该渠道在投递时失败而不是静默丢弃。
- **一次性 ticket 有有效期**（默认 `TAKEOVER_TTL_SECONDS=600`），过期后需要重新触发。

## 环境变量

| 变量                     | 默认值                          | 说明                                             |
| ------------------------ | ------------------------------- | ------------------------------------------------ |
| `HOST`                   | `127.0.0.1`                     | HTTP 绑定地址；容器内用 `0.0.0.0`                |
| `PORT`                   | `8080`                          | HTTP 端口                                        |
| `RUN_DIR`                | `./run`                         | 流程、截图、SQLite 的根目录                      |
| `FLOWS_DIR`              | 自动探测仓库 `flows/`           | 通过 HTTP 提交的流程解析相对 goto URL 的基准目录 |
| `CHROME_PATH`            | 自动探测                        | Chromium/Chrome 可执行文件路径                   |
| `HEADLESS`               | `true`                          | `false` 时 headful（通常配合 Xvfb）              |
| `CHROME_ARGS`            | 空                              | 额外 Chromium 参数，逗号分隔                     |
| `SECRET`                 | `dev-insecure-secret-change-me` | 接管 ticket/WS token 签名密钥，**生产必须替换**  |
| `PUBLIC_URL`             | `http://127.0.0.1:8080`         | 生成接管链接用的外部可达地址                     |
| `TAKEOVER_TTL_SECONDS`   | `600`                           | ticket 有效期（秒）                              |
| `TAKEOVER_SINGLE_CLIENT` | `true`                          | 同一会话只允许一个操作者                         |
| `MAX_CONCURRENCY`        | `2`                             | 并发 worker 进程数                               |
| `TASK_TIMEOUT_MS`        | `900000`                        | 单次任务墙钟预算                                 |
| `TASK_RETRIES`           | `1`                             | 失败重试次数（总尝试次数 = 1 + 重试）            |
| `LOG_LEVEL`              | `info`                          | `fatal`…`trace` / `silent`                       |
| `NOTIFY_CHANNELS`        | `log`                           | 未在 `manual.notify` 中指定时使用的渠道          |
| `WEBHOOK_URL`            | 未设置                          | `webhook` 通知渠道地址                           |
| `FEISHU_WEBHOOK_URL`     | 未设置                          | 飞书自定义机器人 Webhook 地址                    |
| `FEISHU_SECRET`          | 未设置                          | 飞书机器人签名密钥（开启签名校验时必填）         |
| `DINGTALK_WEBHOOK_URL`   | 未设置                          | 钉钉机器人 Webhook 地址（含 `access_token`）     |
| `DINGTALK_SECRET`        | 未设置                          | 钉钉机器人加签密钥（以 `SEC` 开头）              |
| `SMTP_URL`               | 未设置                          | `email` 通知渠道的 SMTP 连接串或 HTTP 网关       |
| `NOTIFY_TO`              | 未设置                          | 邮件默认收件人                                   |
| `NOTIFY_ON_FAILURE`      | `true`                          | 运行失败（报错/超时/中止）时是否也推送通知       |
| `ROBO_CREDENTIALS_FILE`  | `<RUN_DIR>/credentials.json`    | 服务端网页账号密码库（AES-256-GCM 加密文件）     |
| `ROBO_CREDENTIALS_KEY`   | 回落 `SECRET`                   | 凭据库加密密钥，不设且无 `SECRET` 时拒存密码     |
| `TZ`                     | 容器内 `Asia/Shanghai`          | 时区，影响日志与截图时间戳                       |
| `LANG` / `LC_ALL`        | 容器内 `C.UTF-8`                | 语言环境                                         |

流程级覆盖：`manual` 步骤的 `notify: ["feishu","dingtalk","email","webhook","log"]`
决定该次接管用哪些渠道；不写则用 `NOTIFY_CHANNELS`。运行失败通知使用同一份
`NOTIFY_CHANNELS`（受 `NOTIFY_ON_FAILURE` 开关控制）。

## 无头模式：headless=new vs Xvfb

优先用 `HEADLESS=true`（等价于 `chromium --headless=new`）：无显示依赖、启动快、
资源占用低，绝大多数站点都能正常工作。

少数站点会主动探测无头特征（例如 `navigator.webdriver`、缺失 GPU/音频栈、
`window.outerWidth === 0`）。这时改用 Xvfb 提供虚拟显示：

```bash
apt-get install -y xvfb
HEADLESS=false xvfb-run -a --server-args="-screen 0 1920x1080x24" \
  node packages/server/dist/cli.js run flows/demo.json
```

Docker 镜像已安装 `xvfb`，把 `HEADLESS` 设为 `false` 并在入口前套 `xvfb-run` 即可：

```yaml
services:
  robrowser:
    entrypoint:
      [
        'xvfb-run',
        '-a',
        '--server-args=-screen 0 1920x1080x24',
        'node',
        'packages/server/dist/cli.js',
      ]
    environment:
      HEADLESS: 'false'
```

容器内还需要：

- `CHROME_ARGS` 至少包含 `--no-sandbox,--disable-dev-shm-usage`（compose 默认已带）；
  `--no-sandbox` 只应在容器里使用，它会削弱渲染进程的沙箱隔离。
- 安装 `fonts-noto-cjk`，否则中文页面截图与文本提取会出现方块或缺字。
  镜像已包含该字体包。

## Docker 部署

```bash
# 构建并启动
SECRET=$(openssl rand -hex 32) docker compose -f docker/docker-compose.yml up --build

# 查看接管链接（manual 步骤触发时写入容器日志）
docker logs -f robrowser
```

- 数据持久化在 named volume `robrowser-data`（挂载到 `/data`）；
- 默认发布 `8080`，可用 `ROBROWSER_PORT` 覆盖；
- `PUBLIC_URL` 必须是**操作者浏览器可达**的地址（域名 + https 或内网 IP），
  否则通知里的接管链接打不开；
- 生产建议在前面放 Nginx/Caddy 终止 TLS，并把 `PUBLIC_URL` 设为 `https://...`。

### 原生部署

```bash
pnpm install --frozen-lockfile
pnpm build
RUN_DIR=/var/lib/robrowser SECRET=$(openssl rand -hex 32) \
  node packages/server/dist/cli.js serve --host 0.0.0.0 --port 8080
```

用 systemd/supervisor 守护即可；`RUN_DIR` 需要可写，并预留截图与下载产物的空间。

## FlowModel

`FlowModel` 的 zod schema 在 `packages/core/src/flow/schema.ts`，是运行时校验与
TypeScript 类型的唯一来源。

```jsonc
{
  "version": "1.0",
  "id": "demo-login",
  "name": "Demo",
  "variables": {
    "fixtures": { "type": "const", "value": "../fixtures/" },
    "username": { "type": "input", "label": "Username", "default": "alice" },
    "password": { "type": "secret", "key": "DEMO_PASSWORD", "default": "s3cret" },
  },
  "steps": [
    { "id": "open", "type": "goto", "url": "{{fixtures}}login.html" },
    { "id": "login-page", "type": "waitForPage", "target": "login" },
    {
      "id": "fill-user",
      "type": "type",
      "selector": { "testId": "username" },
      "value": "{{username}}",
    },
    { "id": "submit", "type": "click", "selector": { "css": "#submit" } },
  ],
  "onError": { "retry": 1, "backoff": "exponential", "screenshot": true },
}
```

要点：

- 步骤类型：`goto` / `click` / `type` / `select` / `hover` / `scroll` / `waitForPage` /
  `waitForSelector` / `waitForUrl` / `waitForNetworkIdle` / `waitForDownload` /
  `extract` / `screenshot` / `branch` / `loop` / `setVar` / `httpCall` / `manual`。
- `SelectorSpec` 支持 `string`、`{testId}`、`{role,name}`、`{text,exact}`、`{css}`、
  `{xpath}`、`{candidates:[...]}`；`candidates` 按顺序尝试，全部失败才报错。
- 字符串字段支持 `{{name}}` 插值，来源为 const / env / secret / input /
  credential / 步骤输出；未定义变量会抛出带变量名与位置的明确错误。
- `onError` 与步骤级配置共同决定重试策略，退避支持 `none` / `linear` / `exponential`。
- 每步成功后写 `<runDir>/checkpoint.json`，可用 checkpoint 续跑。
- 完整事件：`step:start` / `step:ok` / `step:fail` / `log` / `screenshot` /
  `run:aborted` / `manual:request` / `manual:resolved`，均为类型化事件。

`secret` 变量在运行结果中会被脱敏为 `***`，不会出现在日志或事件里。
登录用的账号密码请用 `credential` 变量（只写凭据名，密码存宿主凭据库），
详见 `网页账号密码（凭据库）` 一节。

## 脚本导出

```bash
# Playwright 脚本（默认 CommonJS，输出 .cjs 即可直接运行）
node packages/server/dist/cli.js export flows/demo.json --target playwright --out run/demo.cjs
node packages/server/dist/cli.js export flows/demo.json --target raw-cdp --out run/demo-raw.cjs

# 直接运行：CHROME_PATH 指向本机 Chromium/Chrome（不要用 Playwright 自带下载，
# 离线环境同样适用）。导出脚本已把流程目录烘焙进去，可从任意 cwd 运行。
$env:CHROME_PATH = "C:\Program Files\Google\Chrome\Application\chrome.exe"
node run/demo.cjs
```

- Playwright 导出把变量映射为 `process.env`（`input` 变量映射为
  `ROBO_<NAME>`），`manual` 步骤生成明确的抛错或等待外部信号的分支；
- `credential` 变量导出为 `ROBO_CRED_<KEY>_USERNAME` /
  `ROBO_CRED_<KEY>_PASSWORD` 环境变量读取，密码绝不写进脚本；
- 相对 `goto` URL 与引擎行为一致：导出时记录流程文件所在目录并解析成
  `file://`，因此 `{{fixtures}}login.html` 这类写法无需手改；
- 启动的浏览器遵循 `CHROME_PATH`（未设置时回落到 Playwright 自带 Chromium），
  可用 `ROBO_FLOW_DIR` 覆盖相对 URL 的基准目录、`ROBO_OUT` 指定产物目录；
- raw-cdp 导出是自包含脚本：内置 `cdp.send` / `evaluate` / `waitFor` /
  `clickSelector` / `typeInto` 辅助函数，可直接 `node script.cjs` 运行；
- 两者都有快照测试（`packages/core/src/exporters/__snapshots__/`），保证输出稳定。

## 脚本导入

导入是导出的逆过程：把已经生成的（或手写的）脚本还原成 `FlowModel`，
重新在节点图里编辑。**脚本只作为数据解析，从不 `eval` / `new Function` / `vm` 执行**，
因此导入来路不明的脚本是安全的。

```bash
# 类型可省略：默认从脚本内容自动识别（Playwright / raw-cdp）
node packages/server/dist/cli.js import run/demo.cjs --out flows/from-script.json
node packages/server/dist/cli.js import run/demo-raw.cjs --target raw-cdp --out flows/from-raw.json

# 不指定 --out 时把流程 JSON 打到 stdout，方便管道处理
node packages/server/dist/cli.js import run/demo.cjs > flows/from-script.json
```

- **往返幂等**：`export(import(export(flow))) === export(flow)`，两个目标都成立
  （见 `packages/core/src/importers/importers.test.ts`）。RoboBrowser 导出的脚本带
  `// <id>: <type>` 锚点注释，步骤 id 与类型因此能精确还原；
- `credential` 变量凭导出器写入的 `__roboCredential` 标记无损还原为
  `credential` 声明，脚本里只有环境变量名，没有密码；
- **手写脚本**同样支持常用写法：`page.goto` / `page.fill(sel, val)` /
  `locator.click()` / `pressSequentially` / `selectOption` / `hover` /
  `waitForSelector` / `waitForURL` / `page.screenshot`，
  以及 `if (...) { ... } else { ... }`（分支）、
  `for` 循环、`vars["x"] = …`（变量）等；
- **无法映射的语句会以 warning 形式返回**（CLI 打到 stderr，桌面端列在对话框里），
  不会静默丢弃；`automate import` 在有 warning 时依然成功，退出码为 0；
- **导出的信息缺失是有边界、可预期的**，因为脚本里本就没有这些字段：

  | 字段 | 原因 |
  | ---- | ---- |
  | `secret` / `env` | 两者的脚本形式完全相同（都是 `process.env["KEY"]`），统一还原为 `env` |
  | `input.label` | 未写入脚本，还原时用变量名代替 |
  | `pageIs` | 无运行时表达，导出为 `true /* pageIs: … */` 注释，可还原 |
  | `waitForPage.timeout`、`loop.maxIterations`、`manual.resolveWhen` / `notify` / `timeoutMs`、`waitForDownload.saveTo` | 导出器不输出 |

- raw-cdp 的 `extract` 属性读取曾把属性名未转义地拼进字符串字面量，生成**无法解析**
  的脚本；本次一并修复，并由快照与 `new Function()` 语法断言覆盖。

## 发布

安装包由 CI 矩阵构建（`.github/workflows/release.yml`），一次产出三个平台的四种产物：
Windows（nsis 安装包）、Linux（AppImage）、macOS（Apple Silicon 与 Intel 各一个 dmg）。

```bash
git tag v0.2.0 && git push origin v0.2.0      # 触发矩阵构建并挂到 GitHub 发行版
```

- **Gitee 是源仓库**：工作流直接从 Gitee 取标签构建（公开仓库无需凭据），
  因此**不依赖** Gitee→GitHub 的镜像流水线；另有每 6 小时的定时任务补建漏掉的标签。
- 也可在 Actions 页面手动 `workflow_dispatch`，填入已有标签只为它补出包。

### 把安装包也放到 Gitee

GitHub runner 向 Gitee 上传约 95MB 的附件**实测不可用**（18 分钟零字节落地），
所以在国内机器上补一步即可（同一批文件约 4 MiB/s）：

```bash
pnpm release:gitee v0.2.0                              # 从 GitHub 发行版拉取资产再上传
pnpm release:gitee v0.2.0 --source local --dir packages/desktop/release
pnpm release:gitee v0.2.0 --dry-run                    # 只检查，不上传
```

- 凭证从**系统凭据库**读取（`git credential fill`，Windows 上是凭据管理器），
  仓库里不放任何令牌；也可用环境变量 `GITEE_TOKEN` 覆盖。
- Gitee 的硬限制（实测而非照文档）：**单附件 100 MiB**、**单仓库发行版附件合计 1 GiB**
  —— 四个 Electron 安装包就占约 360 MiB，所以每两三个版本就要清一次旧附件。
  脚本上传前会检查这两条并给出明确提示。
- 删除类接口（删附件/删发行版/删标签）对个人令牌一律返回 401，
  超额时需到 Gitee 网页上手动删除旧版本的附件。

## 测试

```bash
pnpm test              # Vitest 单元 + 集成 + 接管 e2e（不需要 Electron）
pnpm test:desktop      # Electron 桌面端端到端（smoke + manual e2e）
pnpm lint              # ESLint
pnpm format:check      # Prettier
pnpm verify            # lint + build + test
```

| 范围               | 内容                                                                     |
| ------------------ | ------------------------------------------------------------------------ |
| `packages/core`    | FlowModel 校验、变量/插值、Orchestrator（mock page/manual）、导出器快照  |
| `packages/browser` | SelectorSpec 解析、坐标换算、screencast ack（mock CDPSession）           |
| `packages/server`  | CLI 参数、REST、SQLite、队列重试、token 一次性与重放拒绝                 |
| 集成               | 本地 `fixtures/*.html` 经 `file://` 跑完整 demo（分支 + extract + 截图） |
| 端到端             | `manual` 步骤 + 接管 WebSocket 输入 → 真实无头 Chromium 流程恢复         |

### 桌面端端到端测试

桌面测试不在 Vitest 套件内，因为它们会启动**真正的 Electron 进程**：

```bash
pnpm build                 # 必须先构建：测试跑的是 dist/ 产物
pnpm test:desktop          # smoke + manual 全部跑
pnpm test:desktop:smoke    # 仅启动/内嵌浏览器/CDP 烟雾
pnpm test:desktop:manual   # 仅 manual 步骤 + 本地人工接管（验证 resolveWhen）
```

- 前置条件：先 `pnpm build`；系统需要 **Electron 30+ 与一个 Chromium/Chrome**（可用 `CHROME_PATH` 指定）。
- Windows/macOS 直接运行；无显示器的 Linux CI 需要 Xvfb（见下文无头模式）。
- 测试使用临时 user-data 目录与本地 fixture，不访问公网。

所有测试只访问本地 `file://` fixture 与 loopback HTTP，**不访问公网**。测试会自动探测
Chromium：找不到浏览器时，依赖真实浏览器的用例整体 `skip`（而不是失败），因此在
无浏览器的 CI 上仍保持绿色；安装了 Chrome/Chromium 的环境（或设置了 `CHROME_PATH`）
会真正执行这些用例。

## 常见问题

**`better-sqlite3` 安装失败**：通常是缺少预编译二进制或 Node ABI 不匹配。确认使用
Node 20+，并让 pnpm 执行安装脚本（`pnpm-workspace.yaml` 的 `onlyBuiltDependencies`
已列明 `better-sqlite3`）。

**Chromium 找不到**：设置 `CHROME_PATH`。程序按平台探测常见安装位置，跨平台时
`CHROME_PATH` 是最可靠的方式。

**截图里中文是方块**：安装 `fonts-noto-cjk`，并确认 `LANG`/`LC_ALL` 为 UTF-8。

**接管链接打不开**：`PUBLIC_URL` 必须是操作者机器能访问到的地址；容器内
`127.0.0.1` 指向容器自身。若是 HTTPS 页面，WebSocket 必须用 `wss://`。

**HTTP 提交的流程里相对路径 404**：`goto` 用相对路径时，通过 `POST /runs` 提交的流程没有
自己所在目录，需要设置 `FLOWS_DIR`（不设置时自动向上查找仓库的 `flows/` 目录）。
从 CLI/桌面按文件加载的流程不受影响，它们用文件所在目录。

**多实例部署时 token 可重放**：一次性 `jti` 列表目前是进程内的，
多实例需要换成共享存储（见上文安全要求）。

## 许可

MIT
