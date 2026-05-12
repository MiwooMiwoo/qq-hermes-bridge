# QQ-Hermes Bridge

NapCat OneBot v11 ↔ Hermes Agent 桥接插件。通过 SSE 事件流实现实时消息分割和图片发送。

## ✨ 特性

- **智能消息分割** — 自动检测消息边界，实现消息-工具-消息交替输出
- **图片发送** — 支持本地文件、URL、Base64 三种方式发送图片，图片和文字合并为一条消息
- **命令审批** — 高危命令弹出审批提示，支持回复"批准/拒绝/始终允许"
- **会话保持** — 按群/私聊维护对话历史上下文
- **触发控制** — 支持 @提及、关键词触发、管理员列表
- **自动重连** — WebSocket 断线自动重连

## 📦 安装

### 前置要求

- Node.js >= 18
- [NapCat](https://github.com/NapNeko/NapCatQQ) Docker 部署
- [Hermes Agent](https://github.com/nousresearch/hermes-agent) 运行中（API Server 模式）

### 安装步骤

```bash
# 克隆仓库
git clone https://github.com/MiwooMiwoo/qq-hermes-bridge.git
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
| `BOT_QQ` | (空) | Bot QQ 号 |
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

### 消息

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `MAX_MESSAGE_LENGTH` | `1200` | 单条消息最大长度 |
| `SYSTEM_PROMPT` | (空) | 系统提示词 |
| `LOCAL_HISTORY_MAX_MESSAGES` | `24` | 保留的历史消息轮数 |

### 审批

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `APPROVAL_ENABLED` | `true` | 是否启用命令审批 |
| `APPROVAL_TIMEOUT_SECONDS` | `300` | 审批超时自动拒绝（秒） |

## 🎮 使用方法

### 群聊触发

- `@小喵 帮我搜一下xxx` — @提及触发
- `小喵你好` — 关键词触发（如果配置了 `KEYWORD_TRIGGERS`）

### 私聊

直接发消息即可。

### 停止任务

发送 `停止` 或 `stop` 可中断当前运行的任务。

### 清除上下文

发送以下任意一个命令可清除对话上下文，开始新对话：
- `清除上下文`
- `新对话`
- `new`
- `reset`

### 命令审批

当 agent 执行高危命令时，会弹出审批提示：

```
⚠️ 需要审批
命令: sudo rm -rf /tmp/test
工具: terminal

回复 "批准" / "拒绝" / "始终允许" 来处理
```

回复对应内容即可：
- `批准` / `通过` — 允许一次
- `拒绝` / `deny` — 拒绝执行
- `始终允许` — 本次会话内始终允许

### 图片发送

Hermes 可以在回复中嵌入图片，支持以下格式：

```
MEDIA:/path/to/local/image.png
MEDIA:https://example.com/image.jpg
```

图片会和文字合并为一条消息发送。

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

### 消息分割机制

Bridge 通过检测 `tool.started` 事件来分割消息：

```
message.delta (累积) → tool.started → 发送消息 → 工具执行
message.delta (累积) → tool.started → 发送消息 → 工具执行
...
run.completed → 发送最终回复
```

这实现了类似 TUI 的消息-工具-消息交替输出效果。

### 数据流

1. 用户在 QQ 发消息 → NapCat WebSocket → Bridge
2. Bridge 调用 `POST /v1/runs` 提交异步任务
3. Bridge 连接 `GET /v1/runs/{run_id}/events` SSE 事件流
4. 收到 `message.delta` → 累积消息内容
5. 收到 `tool.started` → 检测到消息边界，发送累积的消息
6. 收到 `approval.request` → 发送审批提示，等待回复
7. 收到 `run.completed` → 发送最终回复（支持图片+文字合并）

## 📝 Changelog

### v3.0.0 (2025-05-13)

- **智能消息分割** — 通过 `tool.started` 事件检测消息边界
- **移除工具进度显示** — 不再发送工具执行状态
- **简化架构** — 核心逻辑集中在消息累积和分割

### v2.0.0 (2025-05-13)

- **完全重写** — 简化架构，移除 Puppeteer/Chrome 依赖
- **纯文字进度** — 进度卡片改为纯文字，不再需要图片渲染
- **图片合并发送** — 图片和文字在同一条消息中发送
- **严格遵循 NapCat API** — 使用标准 OneBot v11 消息段格式

### v1.x

- 使用 Puppeteer 渲染进度卡片图片
- 图片和文字分开发送

## 📄 License

MIT
