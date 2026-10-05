# Changelog

## 0.1.1 - 2026-10-05

### 文档

- README：安装命令改为 npm 为主（`pi install npm:pi-tty7-tab-namer`），npm 徽标链接到 npm 包页，pi-package 徽标链接到 pi.dev 包收录页。

## 0.1.0 - 2026-09-29

### 新功能

- 新增诊断日志：命名全链路决策（触发 / 跳过原因 / 失败原因 / 重试 / 丢弃 / 成功 / 反向同步）逐条写入 `~/.pi/agent/tty7-tab-namer.log`，每行 JSON，超过 256KB 自动清空重写。
- 命名失败自动重试：模型调用超时（20s）、报错或输出为空时，最多尝试 3 次，指数退避（2s、4s）；等待期间切换会话或手动命名会立即中止。仍失败则静默等下一轮补命名。

### 修复

- 修复重试等待期的轮询定时器泄漏（正常醒来后未清理）。
- 修复请求在途时切换会话，旧循环成功后误清新会话的 inFlight 标志，可能导致第三个并发命名请求。

## 0.0.4 - 2026-09-26

### 修复

- 修复 macOS 11 等老系统上安装失败：peerDependencies（仅类型用）改为 optional，`pi install` 不再自动安装它们及其依赖树（esbuild、@smithy 等），安装回到零依赖。esbuild 新版二进制为 macOS 12 编译，在老系统上缺 `_SecTrustCopyCertificateChain` 符号导致 `node install.js` 校验崩溃。

## 0.0.3 - 2026-09-25

### 修复

- 主会话派发 subagent（pi-subagents，同进程 `createAgentSession`）时，子会话的自动名（如 `general-purpose#c897cd1c`）不再覆盖主会话的 Tab 标题与会话名：按子会话 `parentSession` 头部守卫 `session_start` / `before_agent_start` / `session_shutdown`，并在 `session_info_changed` 里按上下文与 `type#hex8` 名称模式双重过滤（不误置 manual，不影响后续自动命名）。
- resume 曾被污染的会话时，已持久化的 subagent 错名不再显示（仍不改盘）。

### 文档

- AGENTS.md 新增第 12 条（子会话必须完全不激活）；README 增加子代理隔离特性说明。

## 0.0.2 - 2026-09-25

### 修复

- `/new` 现在会完整重置 Tab：即使当前 Tab 名来自 tty7 里的手动改名（反向同步），`/new` 也会清空 `name` 字段、回落 tty7 默认标题，进入下一个完整命名周期。此前只有扩展自己写的名字（自动命名 / `/name`）才会在切换会话时被清掉，手动改的 Tab 名会残留到新会话。其他场景（resume / fork / 退出 pi）行为不变：用户手改的名字仍然永久保留。

### 改进

- 反向同步生效时弹出通知：在 tty7 里手动改 Tab 名后，pi 内显示 `Session name set: <名字>`，同步结果可感知。
- 切换到不同 Tab（resume / 移动 pane）时重置 `appliedTabName` 缓存，避免向新 Tab 发出冗余的 rename。
