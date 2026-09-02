# Codex Mobile Bridge

这是一个本机网关，把 Codex `app-server` 的任务状态和对话能力以 MCP HTTP 服务提供给手机上的 agent。

## 能做什么

- `codex_list_projects`：按项目目录汇总任务数量、活动状态和最近任务。
- `codex_list_tasks`：列出 Codex 任务，可按目录或标题筛选。
- `codex_get_progress`：读取任务状态、最近回合、助手回复、命令结果和文件变更摘要。
- `codex_chat`：向已有任务发消息并等待回复；省略 `thread_id` 时创建新任务。

服务通过本机已安装的 `codex app-server --listen stdio://` 连接 Codex，不读取或修改 Codex 数据库文件。

## 启动

要求 Node.js 20+，并且 `codex` CLI 已安装并登录。

仅本机测试：

```powershell
npm start
```

让同一局域网的手机访问：

```powershell
$env:CODEX_BRIDGE_TOKEN = "换成一段随机长密码"
npm start -- --host 0.0.0.0 --port 8787
```

手机端 MCP 地址填写：

```text
http://电脑局域网IP:8787/mcp
```

请求带上：

```text
Authorization: Bearer 换成一段随机长密码
```

也兼容较早的 SSE 客户端：先连接 `/sse`，再使用服务返回的 `/messages?sessionId=...` endpoint。

## 跨网络访问

如果手机 Agent 不在同一局域网，不能直接使用 `127.0.0.1` 或电脑的局域网 IP。优先按手机 Agent 的类型选择下面一种方式。

### OpenAI 手机 Agent：Secure MCP Tunnel（推荐）

Secure MCP Tunnel 不需要开放电脑的入站端口。电脑上的 `tunnel-client` 会通过出站 HTTPS 把本地 MCP 转发给支持该功能的 ChatGPT/Codex surface。

1. 保持桥接服务只监听本机：

   ```powershell
   npm start -- --host 127.0.0.1 --port 8787
   ```

2. 在 [Platform tunnel settings](https://platform.openai.com/settings/organization/tunnels) 创建 `tunnel_id`，并下载最新版 `tunnel-client`。

3. 在另一终端初始化并运行隧道（HTTP MCP 使用 `--mcp-server-url`）：

   ```powershell
   $env:CONTROL_PLANE_API_KEY = "sk-..."
   tunnel-client init `
     --sample sample_mcp_stdio_local `
     --profile codex-bridge `
     --tunnel-id tunnel_... `
     --mcp-server-url http://127.0.0.1:8787/mcp
   tunnel-client doctor --profile codex-bridge --explain
   tunnel-client run --profile codex-bridge
   ```

   如果本机版本的 sample 名称不同，以 `tunnel-client help quickstart` 输出为准；关键配置是隧道 ID 和 `http://127.0.0.1:8787/mcp`。

4. 在 ChatGPT 的开发者模式应用中选择 **Tunnel**，选择同一个 `tunnel_id`。测试期间必须保持 `tunnel-client run` 运行。

这条路径不需要给手机填写本机 URL，也不需要设置 `CODEX_BRIDGE_TOKEN`，因为桥接服务只接受本机隧道客户端的回环连接。

### 其他手机 Agent：公网 HTTPS 代理

如果手机端不是支持 Secure MCP Tunnel 的 OpenAI surface，需要使用 Cloudflare Tunnel、Tailscale Funnel、ngrok 或自建 HTTPS 反向代理，把 `https://你的域名/mcp` 转发到 `http://127.0.0.1:8787/mcp`。此时必须设置 `CODEX_BRIDGE_TOKEN`，并在手机 Agent 中同时配置该 Bearer token；不要把未加密的 HTTP 端口直接暴露到公网。

## 本机快速检查

启动后可以用下面的请求确认 MCP 握手和工具列表：

```powershell
$body = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}'
Invoke-RestMethod -Uri http://127.0.0.1:8787/mcp -Method Post -ContentType 'application/json' -Body $body
```

然后携带响应头里的 `Mcp-Session-Id` 调用 `tools/list` 或 `tools/call`。部分 MCP 客户端会自动管理这个响应头；`/healthz` 可用于检查服务进程是否存活。

## 安全边界

- 默认只监听 `127.0.0.1`。绑定 `0.0.0.0` 或其他非回环地址时，没有 token 会拒绝启动。
- 通过公网 HTTPS 代理时，远程请求只能通过 Bearer token 认证；建议使用随机长 token、限制 Windows 防火墙来源，并优先放在 Tailscale/VPN 内。OpenAI surface 可优先使用上面的 Secure MCP Tunnel。
- Codex 发来的命令、文件变更和旧版 patch 审批请求会被网关默认拒绝，避免手机断线时出现无人值守操作。需要执行写操作时，应在本机 Codex 界面完成确认，或在新建远程任务时明确传入 `codex_chat` 的 `sandbox`/`approval_policy` 参数并承担风险。
- 新建的远程任务默认使用 `read-only` sandbox；已有任务沿用其 Codex 设置。
- 服务只返回任务摘要和助手消息，不返回隐藏思维链。

## 配置

命令行参数：`--host`、`--port`、`--token`、`--cwd`、`--codex-bin`。

对应环境变量：`CODEX_BRIDGE_HOST`、`CODEX_BRIDGE_PORT`、`CODEX_BRIDGE_TOKEN`、`CODEX_BRIDGE_CWD`、`CODEX_BIN`。手机 agent 的 MCP 配置通常只需要 URL 和 Bearer token。

如果使用浏览器里的 MCP 客户端，额外设置 `CODEX_BRIDGE_CORS_ORIGIN` 为该客户端的精确 origin；默认不开放浏览器跨域调用。
