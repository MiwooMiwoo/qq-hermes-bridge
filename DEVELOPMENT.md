# 开发文档

## 项目结构

```
qq-hermes-bridge/
├── src/
│   ├── index.js        # 主入口，消息处理、进度跟踪、审批处理
│   ├── config.js       # 配置加载（.env 解析）
│   ├── onebot.js       # OneBot v11 WebSocket 客户端
│   ├── hermes.js       # Hermes API 客户端（/v1/runs + SSE）
│   └── renderer.js     # HTML → PNG 图片渲染（Puppeteer）
├── .env.example        # 配置模板
├── .env                # 实际配置（不提交）
├── package.json
├── qq-hermes-bridge.service  # systemd 服务文件
├── README.md           # 用户文档
├── DEVELOPMENT.md      # 开发文档（本文件）
└── LICENSE
```

## 核心模块

### config.js

从 `.env` 文件加载配置，合并 `process.env`。导出 `config` 对象。

```js
import { config } from "./config.js";
console.log(config.botQq); // "1466674583"
```

### onebot.js

OneBot v11 WebSocket 客户端。支持：

- 连接/重连
- 事件监听（`message.group`, `message.private` 等）
- API 调用（`send_group_msg`, `send_private_msg`）
- 转发消息（`send_group_forward_msg`）
- 回复消息（带 reply segment）

```js
const onebot = new OneBotClient();
onebot.on("message.group", (event) => {
  console.log(event.message);
});
onebot.connect();
await onebot.sendGroupMsg(groupId, "hello");
```

### hermes.js

Hermes API 客户端。核心功能：

- `submitRun()` — POST `/v1/runs`，异步提交任务
- `streamEvents()` — GET `/v1/runs/{id}/events`，SSE 事件流
- `resolveApproval()` — POST `/v1/runs/{id}/approval`
- `stopRun()` — POST `/v1/runs/{id}/stop`

```js
const hermes = new HermesClient();
const { runId } = await hermes.submitRun({
  userMessage: "帮我搜一下天气",
  sessionId: "group:123456",
});

hermes.streamEvents(runId, {
  "tool.started"(ev) { console.log("tool:", ev.tool); },
  "tool.completed"(ev) { console.log("done:", ev.tool); },
  "run.completed"(ev) { console.log("result:", ev.output); },
  _end() { console.log("stream closed"); },
});
```

### renderer.js

Puppeteer 渲染器，将 HTML 卡片渲染为 PNG。

- `renderProgressHtml()` — 生成进度卡片 HTML
- `renderApprovalHtml()` — 生成审批卡片 HTML
- `renderProgressImage()` — 渲染进度卡片为 base64 PNG
- `renderApprovalImage()` — 渲染审批卡片为 base64 PNG
- `htmlToImage()` — 底层 HTML → PNG
- `closeRenderer()` — 关闭浏览器

浏览器按需启动（首次渲染时），共享实例，关闭时自动清理。

### index.js

主入口，负责：

1. **消息处理** — 接收 OneBot 消息事件，触发检查，提交到 Hermes
2. **进度跟踪** — 监听 SSE 事件，维护每个 run 的状态
3. **进度发送** — 频率限制，渲染图片或文字发送
4. **审批处理** — 接收审批请求，发送审批卡片，处理回复
5. **会话管理** — 按群/私聊维护历史消息

## SSE 事件格式

Hermes API Server 通过 `/v1/runs/{id}/events` 发送以下事件：

### tool.started

```json
{
  "event": "tool.started",
  "run_id": "run_abc123",
  "timestamp": 1715555555.123,
  "tool": "terminal",
  "preview": "curl -s https://api.example.com"
}
```

### tool.completed

```json
{
  "event": "tool.completed",
  "run_id": "run_abc123",
  "timestamp": 1715555556.456,
  "tool": "terminal",
  "duration": 1.333,
  "error": false
}
```

### message.delta

```json
{
  "event": "message.delta",
  "run_id": "run_abc123",
  "timestamp": 1715555557.789,
  "delta": "这是回复的"
}
```

### approval.request

```json
{
  "event": "approval.request",
  "run_id": "run_abc123",
  "timestamp": 1715555558.012,
  "command": "sudo rm -rf /tmp/test",
  "pattern_key": "terminal:dangerous",
  "pattern_keys": ["terminal:dangerous", "terminal:rm"],
  "description": "删除文件或目录",
  "choices": ["once", "session", "always", "deny"]
}
```

### run.completed

```json
{
  "event": "run.completed",
  "run_id": "run_abc123",
  "timestamp": 1715555559.345,
  "output": "最终回复文本...",
  "usage": {
    "input_tokens": 1500,
    "output_tokens": 300,
    "total_tokens": 1800
  }
}
```

### run.failed

```json
{
  "event": "run.failed",
  "run_id": "run_abc123",
  "timestamp": 1715555560.678,
  "error": "Agent iteration limit exceeded"
}
```

## 防刷屏机制

进度发送使用互斥锁 + 时间限制双重保护：

```
message.delta 事件
    │
    ▼
shouldSendProgress()?
    │
    ├─ sendingProgress == true? → 跳过（正在发送中）
    ├─ 距上次发送 < 15秒? → 跳过（频率限制）
    └─ 通过 → sendProgressCard()
                │
                ├─ 设置 sendingProgress = true（锁定）
                ├─ 渲染图片
                ├─ 发送
                └─ finally: sendingProgress = false（解锁）
```

## 图片渲染

使用 `puppeteer-core` + 系统 Chrome/Chromium：

1. 生成 HTML（深色卡片风格）
2. Puppeteer 启动 headless Chrome
3. 设置 viewport 宽度 500px
4. 注入 HTML
5. 自适应内容高度
6. 截图 PNG
7. 转 base64 (`base64://...`)
8. 通过 OneBot 发送

浏览器实例全局共享，首次渲染时启动，进程退出时关闭。

Chrome 路径查找顺序：
1. `~/.agent-browser/browsers/chrome-*/chrome`
2. `/usr/bin/chromium-browser`
3. `/usr/bin/chromium`
4. `/usr/bin/google-chrome`

## 添加新功能

### 添加新的 SSE 事件处理

在 `index.js` 的 `hermes.streamEvents()` 回调中添加：

```js
"new.event.type"(ev) {
  // 处理新事件
},
```

### 添加新的触发方式

修改 `shouldTrigger()` 函数：

```js
function shouldTrigger(event) {
  // 现有逻辑...
  
  // 新增：特定指令触发
  const text = extractText(event.message);
  if (text.startsWith("/")) return { triggered: true, reason: "command" };
  
  return { triggered: false };
}
```

### 自定义卡片样式

修改 `renderer.js` 中的 `renderProgressHtml()` 和 `renderApprovalHtml()` 函数的 HTML/CSS。

## 调试

```bash
# 前台运行查看日志
cd ~/.hermes/plugins/qq-hermes-bridge
node src/index.js

# 查看 systemd 服务日志
journalctl --user -u qq-hermes-bridge -f

# 查看错误
journalctl --user -u qq-hermes-bridge -p err

# 检查 NapCat 连接
docker logs napcat --tail 20

# 检查 Hermes API
curl -s http://127.0.0.1:8642/health

# 测试 Puppeteer 渲染
node -e "
import puppeteer from 'puppeteer-core';
const b = await puppeteer.launch({
  headless: 'new',
  executablePath: '/usr/bin/chromium-browser',
  args: ['--no-sandbox']
});
const p = await b.newPage();
await p.setContent('<h1>Test</h1>');
await p.screenshot({path: '/tmp/test.png'});
await b.close();
console.log('OK');
"
```

## 依赖

| 包 | 用途 |
|---|------|
| `ws` | OneBot v11 WebSocket 客户端 |
| `puppeteer-core` | HTML → PNG 渲染（不捆绑 Chrome） |

## 注意事项

- NapCat 运行在 Docker 中，不能访问宿主机文件路径，图片必须用 base64 发送
- Puppeteer 首次渲染有冷启动延迟（~2-3秒），后续复用浏览器实例
- SSE 连接是长连接，网络断开会自动触发 run 完成处理
- 审批超时后自动 deny，不会无限等待
