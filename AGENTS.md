# AGENTS.md

pi 扩展：用大模型自动为会话命名，并同步到 [tty7](https://github.com/l0ng-ai/tty7) 终端的 Tab 标题。手动 `/name` 优先，永不被自动命名覆盖。

## 项目结构

```
extensions/index.ts   # 扩展本体（唯一源码文件，~200 行）
test/sanitize.test.ts         # sanitizeTitle 自检（node:assert，无测试框架）
package.json                  # pi 包清单（"pi": {"extensions": ["extensions/*.ts"]}）
```

## 必读背景

- **宿主**：pi（@earendil-works/pi-coding-agent）。扩展通过 `pi.on(事件)` 挂钩，API 类型来自 `@earendil-works/pi-coding-agent` 的 `ExtensionAPI` / `ExtensionContext`。
- **终端**：tty7 是一个开源终端。本扩展**只在 `process.env.TTY7` 存在时激活**（与 tty7 官方 hook `~/.pi/agent/extensions/tty7` 的守卫约定一致）。
- **两条通道分工**：会话状态/通知走 tty7 官方 agent-hook bridge；本扩展只负责"命名 + Tab 标题"，标题走 **OSC 转义序列**（tty7 的 CLI 没有设置 pane 标题的命令，这是验证过的结论）。
- 本地开发用 `pi -e .` 试用（不写配置）；正式安装走 `pi install`，settings.json 的 `packages` 里以相对路径引用。

## 关键约定与坑（改代码前必读）

0. **tty7 有两个二进制**：`/Applications/tty7.app/Contents/MacOS/tty7`（CLI，即 `/usr/local/bin/tty7`，支持 `tab ls --json`、`events --json`、`tab rename`）和 `tty7-app`（GUI bundle，只支持 `agent-hook` verb，其他命令**静默返回空**）。扩展用 `TTY7_CLI` 环境变量可覆盖 CLI 路径，默认 `/usr/local/bin/tty7`。官方 bridge（`~/.pi/agent/extensions/tty7/index.ts`）用的 EXE 是 `tty7-app`——那是给 `agent-hook` 用的，别混用。

1. **标题最后一笔必须是本扩展写的纯 `{name}`**。pi 核心会在 `session_info_changed` 之后用 `π - {name} - {cwd}` 格式重写标题，且晚于扩展 handler。所以所有标题写入都经 `setTitleSoon()`（setTimeout 0 延迟一 tick）。标题格式用户明确要求**只显示 `{name}`**，不要加前后缀。
2. **命名是 fire-and-forget 并发**：在 `before_agent_start`（拿到 prompt 瞬间）就发小请求，不阻塞回合。不能等 `agent_end`——用户嫌那样反应慢，这是明确的产品决策。
3. **代数计数器 `gen`**：每次会话切换/退出 `gen++`。命名请求在途时若 gen 变了，结果必须丢弃，防止把名字写到别的会话上。
4. **手动命名判定**：`session_info_changed` 里 `event.name !== undefined` 即视为手动（用 `suppressInfo` 标志排除自己 set 触发的那次）。一旦 manual=true，自动命名对当前会话永久失效。
5. **上下文命名**：resume/fork 一个从未命名的会话时，取**最近 10 条用户消息**（`HISTORY_MESSAGES`，截断 2000 字符）为整个会话命名，不能只看追加的那条新消息——这是用户验证过的用例。
6. **失败重试 + 指数退避**：模型调用 20s 超时或出错时最多尝试 3 次（退避 2s、4s），等待期间会话切换或手动命名立即中止。仍失败则静默等下一轮。不弹通知。
7. **诊断日志**：命名全链路决策写入 `~/.pi/agent/tty7-tab-namer.log`（每行 JSON，超 256KB 自动清空）：trigger / skip / naming-start / naming-failed（timeout/error/empty-after-sanitize/exhausted，带 attempt）/ naming-retry / naming-dropped / naming-done / reverse-sync。排查“第一次消息没出名字”先看这个文件。
8. **session_shutdown** 时 `applyName(null)` 重置标题，Tab 回落 tty7 默认。
9. 标题模型输出必须过 `sanitizeTitle()`：取首个非空行、去引号/书名号/尾标点、截断 20 字符。
10. **tty7 Tab 的 name 与 label 是两个字段**：OSC 标题只写 `label`；用户手动改 Tab 名写 `name`，且 **GUI 显示优先 `name`**（实测结论）。所以一旦 tab 有 name，仅靠 OSC 的内部命名会被遮蔽——内部命名（`/name`、自动命名、resume 已命名会话）必须同时调 `tty7 tab rename <tabUUID> <name>`（`tab rename` 支持 UUID 直连）。改名回空串 `""` 可清空 name 字段。
11. **双向同步**：`tty7 events --json` 常驻子进程监听 `tab_renamed`（只在用户手动改名时发出；本扩展的 OSC 写入只产生 `pane_facts.osc_title`，不触发 rename 事件，故无回环）。pane→tab 映射用 `$TTY7_PANE` 反查 `tab ls --json`，事件 tab id 对不上时惰性重查。收到匹配改名 → `manual=true`（与 `/name` 同优先级）→ `setSessionName`。空名/同名 no-op。`session_shutdown` 杀子进程，进程崩溃静默、下次 session_start 重启。
12. **双向同步的三个状态标志**（防止事件回声把自动命名误升为手动）：`selfRename` 标记自己发出的 rename，回声事件匹配后忽略；`appliedTabName` 缓存当前 tab name，同名不发冗余 rename；`tabNameOurs` 标记 tab name 是本扩展写的——只有它为 true 时，shutdown/切换会话才清空 tab name 回落默认（用户手改的名字永久保留）。例外：`session_start` reason === "new"（`/new`）视为完整新周期，tab name 一律清空回落默认，包括反向同步来的手动名。
13. **子会话（subagent）必须完全不激活**：主会话派发的 subagent 是独立 pi 子进程，会继承 `TTY7`/`TTY7_PANE`，若不拦截会把子会话名（如 `general-purpose#c897cd1c`）写进主会话的 Tab。子会话 session 文件头部有 `parentSession` 字段（普通会话没有），用 `ctx.sessionManager.getHeader()?.parentSession` 检测；在 `session_start`/`before_agent_start`/`session_shutdown` 三个入口开头直接 return。注意 subagent 是**同进程**内跑的（pi-subagents `createAgentSession`），其 `session_info_changed`（子会话 `setSessionName("type#hex8")` 触发）也会到达本扩展，因此该 handler 里还要按 ctx 守卫 + 按 `SUBAGENT_NAME`（`^[\w-]+#[0-9a-f]{8}$`）模式忽略；这个错名甚至可能被持久写进主会话文件，session_start 显示已存名字时也要过滤。

## 命令

```bash
npm test        # sanitizeTitle 自检（node --experimental-strip-types）
pi -e .         # 本地试用扩展
pi list         # 确认扩展已加载
```

## 测试用例（用户手工验收过的，改动后建议复测）

- 新会话第一条消息 → 几秒内 Tab 显示 ≤10 字中文标题
- 载入未命名历史会话并追加不相关问题 → 命名反映整个会话主题，而非最后一条
- `/name xxx` → Tab 立即更新，之后自动命名不再生效
- resume 已命名会话 → Tab 立即显示名字；退出 pi → Tab 回落默认
- 在 tty7 外部手动改 Tab 名 → pi 会话名同步为该名字，之后自动命名不再生效
- 外部改名后再在 pi 内 `/name` → Tab 仍能跟随（内部命名走 `tab rename`，不被 name 字段遮蔽）

## 当前状态

- v0.1.0 已发布：npm（`pi install npm:pi-tty7-tab-namer`）+ GitHub https://github.com/ifyour/pi-tty7-tab-namer（tag + Release 已建）
- 分发：纯 TS 源码、无构建产物；`files: ["extensions", "README.md"]`，npm 自动附带 LICENSE / package.json

## 发布流程（npm）

1. 确认 registry：官方源 `https://registry.npmjs.org/`（`npm config get registry`）。镜像源 npmmirror 只用于拉包，**发布必须走官方源**
2. 改 `package.json` 的 version（同步 CHANGELOG）
3. `npm test` 通过，`npm pack --dry-run` 检查 tarball 内容
4. 发布：`npm publish --access public --auth-type=web`
   - 账号 2FA 是 **passkey**（Touch ID），CLI 用 `--auth-type=web` 走浏览器授权，**不是** `--otp`
   - 若报 E401/未登录：先 `npm login --auth-type=web`
   - 发布后验证：`npm view pi-tty7-tab-namer version`
5. GitHub 打 tag + Release，同步更新 README 安装命令

### 2FA 注意事项（2025-11 后的 npm 政策）

- 发布强制要求 2FA（passkey 或带 bypass-2FA 的 granular token）
- 新绑定 2FA 只支持 passkey/安全密钥，**TOTP（认证器扫码）已停止新增**
- passkey 模式下 CLI 发布/登录都走 `--auth-type=web` 浏览器弹窗授权
- npm 官方源登录凭据与镜像源互不相通；全局切源用 `npm config set registry`

## 风格

- 单文件、零配置、零依赖（peerDependencies 仅为类型）。能不加配置项就不加。
- 默认简体中文交流与文档；代码注释英文。
