# Local Model Connector

OpenHarmony 本地 AI 模型连接器 —— 通过 Chrome 扩展桥接本地模型管家，对外暴露 OpenAI 兼容 API。

## 背景

OpenHarmony 上的本地 AI 模型管家（类似 Ollama）通过 `localhost:11434` 提供服务，但有严格的白名单权限控制。海泰浏览器在白名单内，因此我们通过 Chrome 扩展作为桥梁，将请求从本地代理服务器转发到模型管家，最终对外暴露一个 OpenAI 兼容 API，供 opencode/openclaw 等工具使用。

## 架构

```
opencode/openclaw ──HTTP──> Node.js Proxy Server (localhost:11435)
                                    │
                                    │ WebSocket (ws://localhost:11435/ws)
                                    ▼
                             Chrome Extension (海泰浏览器, MV3)
                                    │
                                    │ HTTP/fetch (白名单放行)
                                    ▼
                             AI 模型管家 (localhost:11434)
```

单端口设计：HTTP API 和 WebSocket 共用 11435 端口。

## 项目结构

```
local-model-connector/
├── package.json                 # Node.js 项目配置
├── server/
│   ├── index.js                 # 入口：创建 HTTP + WebSocket 服务
│   ├── config.js                # 配置管理（端口、目标地址等）
│   ├── bridge.js                # WebSocket 桥接管理（与扩展通信）
│   └── handler.js               # HTTP 请求处理（OpenAI 兼容路由）
└── extension/
    ├── manifest.json            # Manifest V3 配置
    ├── background.js            # Service Worker（WebSocket 客户端 + HTTP 代理）
    ├── popup.html               # 状态弹窗
    └── popup.js                 # 弹窗脚本
```

## 组件详细设计

### 1. Node.js Proxy Server (server/)

#### config.js — 配置管理

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `API_PORT` | 11435 | 代理服务器监听端口 |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | 模型管家地址 |
| `REQUEST_TIMEOUT` | 120000 (2 分钟) | 请求超时时间 (ms) |

所有配置均可通过同名环境变量覆盖。

#### bridge.js — WebSocket 桥接管理器

- 管理与 Chrome 扩展的 WebSocket 连接
- 请求多路复用：用 UUID 作为 requestId 追踪并发请求
- 提供 `sendRequest(method, path, headers, body)` 方法，返回 Promise（非流式）
- 提供 `sendStreamingRequest(method, path, headers, body)` 方法，返回 EventEmitter（流式）
- 超时处理：120s 无响应则超时
- 扩展断开时自动 reject 所有 pending 请求

#### handler.js — HTTP 请求处理器

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/v1/models` | 获取模型列表 |
| POST | `/v1/chat/completions` | 对话补全（支持流式） |
| POST | `/v1/completions` | 文本补全（支持流式） |
| POST | `/v1/embeddings` | 文本向量化 |
| GET | `/health` | 健康检查，返回连接状态 |
| OPTIONS | `*` | CORS 预检请求 |

所有 `/v1/*` 请求透传到扩展再转发至模型管家。检测请求体中 `stream: true` 时自动切换为 SSE 流式响应。扩展未连接时返回 503 + OpenAI 错误格式。

#### index.js — 服务入口

- 创建 HTTP 服务器处理 API 请求
- 在同一端口上通过 `upgrade` 事件处理 WebSocket 连接（`/ws` 路径）
- 启动时打印配置信息和使用说明

### 2. Chrome Extension (extension/)

#### manifest.json

- Manifest V3
- 权限：`storage`（保存连接状态）
- Host 权限：`http://localhost:11434/*`（访问模型管家）
- Background：Service Worker (`background.js`)

#### background.js — Service Worker

- 启动时连接 `ws://localhost:11435/ws`
- 断线自动重连（指数退避，初始 1s，最大 30s）
- 收到请求消息后，使用 `fetch()` 转发到 `localhost:11434`
  - 非流式：整个响应 body 一次性返回
  - 流式：使用 `response.body.getReader()` 逐块读取，通过 WebSocket 分块发送
- 心跳机制：每 30s 发送 ping 保持连接

#### popup.html / popup.js — 状态面板

- 显示连接状态（已连接 🟢 / 已断开 🔴 / 重连中 🟡）
- 显示代理服务器地址和模型管家地址
- 显示已转发请求计数
- 每 2s 自动刷新

## WebSocket 通信协议

Server 与 Extension 之间通过 JSON 消息通信，使用 `id` 字段实现请求多路复用。

### 请求 (Server → Extension)

```json
{
  "id": "request-uuid",
  "type": "request",
  "method": "POST",
  "path": "/v1/chat/completions",
  "headers": {"Content-Type": "application/json"},
  "body": "{\"model\":\"qwen\",\"messages\":[...]}",
  "stream": true
}
```

### 非流式响应 (Extension → Server)

```json
{
  "id": "request-uuid",
  "type": "response",
  "status": 200,
  "headers": {"Content-Type": "application/json"},
  "body": "{...完整响应...}"
}
```

### 流式响应 (Extension → Server)

```json
{"id": "request-uuid", "type": "stream-start", "status": 200, "headers": {...}}
{"id": "request-uuid", "type": "stream-chunk", "data": "data: {\"id\":\"chatcmpl-...\"}\n\n"}
{"id": "request-uuid", "type": "stream-end"}
```

### 错误 (Extension → Server)

```json
{"id": "request-uuid", "type": "error", "status": 502, "message": "Connection refused"}
```

### 心跳

```json
{"type": "ping"}
{"type": "pong"}
```

## 依赖

- **`ws`** — WebSocket 服务器（~50KB）
- Node.js 内置模块：`http`, `crypto`, `events`, `url`

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 启动代理服务器
node server/index.js

# 3. 在海泰浏览器中加载扩展
#    打开扩展管理页 → 开发者模式 → 加载已解压的扩展 → 选择 extension/ 目录

# 4. 检查扩展 popup 显示 "已连接"
```

## 验证

```bash
# 健康检查
curl http://localhost:11435/health

# 获取模型列表
curl http://localhost:11435/v1/models

# 非流式对话
curl http://localhost:11435/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen","messages":[{"role":"user","content":"你好"}]}'

# 流式对话
curl http://localhost:11435/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen","messages":[{"role":"user","content":"你好"}],"stream":true}'
```

## 接入 opencode / openclaw

```bash
export OPENAI_BASE_URL=http://localhost:11435/v1
```
