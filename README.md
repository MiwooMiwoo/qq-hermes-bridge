# QQ-Hermes Bridge

NapCat OneBot v11 ↔ Hermes Agent 桥接插件。通过 SSE 事件流实现实时进度通知，支持图片卡片渲染和命令审批。

## ✨ 特性

- **SSE 流式进度** — 通过 `/v1/runs` 异步 API + `/v1/runs/{id}/events` SSE 事件流实时获取 agent 执行进度
- **图片卡片** — 进度和审批请求渲染为深色风格 PNG 图片发送，避免刷屏
- **防刷屏** — 可配置的进度更新频率限制（默认 15 秒一次）
- **命令审批** — 高危命令弹出审批卡片，支持回复"批准/拒绝/始终允许"
- **会话保持** — 按群/私聊维护对话历史上下文
- **触发控制** — 支持 @提及、关键词触发、管理员列表
- **自动重连** — WebSocket 断线自动重连

## 📦 安装

### 前置要求

- Node.js >= 18
- [NapCat](https://github.com/NapNeko/NapCatQQ) Docker 部署
- [Hermes Agent](https://github.com/nousresearch/hermes-agent) 运行中（API Server 模式）
- Chromium / Chrome（用于图片渲染，可选）

### 安装步骤

```bash
# 克隆仓库
git clone https://github.com/Amorter/qq-hermes-bridge.git
cd qq-hermes-bridge

# 安装依赖
npm install

# 复制并编辑配置
cp .env.example .env
nano .env

# 测试运行
node src/index.js
```

### systemd 服务（推荐）

```bash
# 复制服务文件
cp qq-hermes-bridge.service ~/.config/systemd/user/

# 重载并启动
systemctl --user daemon-reload
systemctl --user enable --now qq-hermes-bridge.service

# 查看状态
systemctl --user status qq-hermes-bridge

# 查看日志
journalctl --user -u qq-hermes-bridge -f
```

## ⚙️ 配置

编辑 `.env` 文件：

### NapCat 连接

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `ONEBOT_WS_URL` | `ws://127.0.0.1:3001` | NapCat WebSocket 地址 |
| `ONEBOT_ACCESS_TOKEN` | (空) | OneBot Access Token |

### Hermes API

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `HERMES_API_URL` | `http://127.0.0.1:8642` | Hermes API Server 地址 |
| `HERMES_API_KEY` | (空) | API Key（如果配置了认证） |

### Bot 身份

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `BOT_QQ` | `1466674583` | Bot QQ 号 |
| `BOT_NAME` | `小喵` | Bot 名称 |

### 访问控制

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `ADMINS` | (空) | 管理员 QQ 号，逗号分隔 |
| `ALLOWED_GROUPS` | (空) | 允许的群号，逗号分隔。空=全部允许 |
| `ALLOWED_USERS` | (空) | 允许的用户 QQ 号，逗号分隔 |
| `BLOCKED_USERS` | (空) | 屏蔽的用户 QQ 号，逗号分隔 |

### 触发方式

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `REQUIRE_MENTION` | `true` | 群聊中是否需要 @bot 才触发 |
| `KEYWORD_TRIGGERS` | `小喵,喵神,...` | 关键词触发列表，逗号分隔 |

### 进度通知

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PROGRESS_RATE_LIMIT_SECONDS` | `15` | 进度卡片发送最小间隔（秒） |
| `PROGRESS_AS_IMAGE` | `true` | 是否以图片形式发送进度 |
| `PROGRESS_MAX_TOOLS` | `12` | 进度卡片最多显示的工具数量 |

### 审批

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `APPROVAL_ENABLED` | `true` | 是否启用命令审批 |
| `APPROVAL_TIMEOUT_SECONDS` | `300` | 审批超时自动拒绝（秒），0=不超时 |

### 消息

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `MAX_MESSAGE_LENGTH` | `1200` | 单条消息最大长度 |
| `SYSTEM_PROMPT` | (内置) | 系统提示词 |
| `LOCAL_HISTORY_MAX_MESSAGES` | `24` | 保留的历史消息轮数 |

## 🎮 使用方法

### 群聊触发

- `@小喵 帮我搜一下xxx` — @提及触发
- `小喵你好` — 关键词触发（如果配置了 `KEYWORD_TRIGGERS`）
- 回复 bot 的消息 — 回复触发

### 私聊

直接发消息即可。

### 停止任务

发送 `停止` 或 `stop` 可中断当前运行的任务。

### 命令审批

当 agent 执行高危命令时，会弹出审批卡片：

```
⚠️ 需要审批
模式: terminal:dangerous
命令: sudo rm -rf /tmp/test
说明: 删除文件或目录
风险: 🔴 高

回复 "批准" / "拒绝" / "始终允许" 来处理
```

回复对应内容即可：
- `批准` / `通过` — 允许一次
- `拒绝` / `deny` — 拒绝执行
- `始终允许` — 本次会话内始终允许

## 📐 架构

```
┌─────────────┐    WebSocket     ┌──────────┐
│  QQ 用户群   │ ◄──────────────► │  NapCat   │
└─────────────┘    OneBot v11    │  Docker   │
                                 └─────┬────┘
                                       │
                                 ┌─────▼────┐
                                 │  Bridge   │
                                 │  (Node.js)│
                                 └─────┬────┘
                                       │
                    POST /v1/runs      │     GET /v1/runs/{id}/events
                    (异步提交)          │     (SSE 事件流)
                                 ┌─────▼────┐
                                 │  Hermes   │
                                 │ API Server│
                                 │  :8642    │
                                 └──────────┘
```

### 数据流

1. 用户在 QQ 发消息 → NapCat WebSocket → Bridge
2. Bridge 调用 `POST /v1/runs` 提交异步任务
3. Bridge 连接 `GET /v1/runs/{run_id}/events` SSE 事件流
4. 收到 `tool.started` / `tool.completed` → 收集进度
5. 每 15 秒渲染一次进度卡片（HTML → PNG）发送到 QQ
6. 收到 `approval.request` → 发送审批卡片，等待回复
7. 收到 `run.completed` → 发送最终回复

## 🔧 开发

详见 [DEVELOPMENT.md](./DEVELOPMENT.md)

## 📝 Changelog

### v1.0.0 (2025-05-13)

- 初始发布
- SSE 流式进度
- 图片卡片渲染（Puppeteer）
- 命令审批
- 会话保持
- systemd 服务支持

## 📄 License

MIT
