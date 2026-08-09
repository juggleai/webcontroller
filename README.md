# JuggleWork Desktop 远程控制诊断台

本机运行的零依赖 Web 页面，用于验证：

- `https://work.juggle.im` 可访问性与 CORS；
- Cloud 账号登录和组织选择；
- Desktop remote-control feature gates；
- 已注册 Desktop 的在线、离线、心跳 generation 和能力广告；
- 通过稳定的 scoped control session、持久化 command 和可恢复 SSE 读取并增量更新会话；
- 当前端到端控制链路还缺少哪些增强环节。

## 运行

```bash
cd controlweb
npm start
```

浏览器打开：

```text
http://127.0.0.1:4177
```

也可以使用环境变量更改监听端口：

```bash
CONTROLWEB_PORT=4180 npm start
```

## 安全说明

- 密码只用于登录请求，不保存。
- Cloud session token 只保存在页面 JavaScript 内存中。
- 页面刷新或关闭会清除 token。
- 页面不使用 `localStorage` 或 `sessionStorage` 保存凭证。
- “复制报告”会排除 session token 和密码。

## 当前能力与限制

当前 Server 和 Desktop 已实现：

- 设备注册、PoP 认证、出站 WSS、presence、心跳和能力发布；
- discovery/workspace/session 三层只读 control session；
- durable command、generation-fenced WSS delivery、可恢复 SSE 和有界 polling fallback；
- Desktop `workspace.list`、`session.list`、`session.snapshot` handlers；
- 有界、内容最小化的会话快照。

当前页面可以读取本机工作区、会话和快照，并应用规范化 transcript/todo/interaction/status 增量事件。设备广告并由策略启用时也支持 `session.prompt` 和 guarded `session.abort`；历史 transcript 分页仍未实现。
