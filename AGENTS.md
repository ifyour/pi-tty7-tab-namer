# AGENTS.md

pi 扩展：用大模型自动为会话命名，并同步到 [tty7](https://github.com/l0ng-ai/tty7) 终端的 Tab 标题。手动 `/name` 优先，永不被自动命名覆盖。

## 项目结构

```
extensions/tab-namer.ts   # 扩展本体（唯一源码文件，~200 行）
test/sanitize.test.ts         # sanitizeTitle 自检（node:assert，无测试框架）
package.json                  # pi 包清单（"pi": {"extensions": ["extensions/*.ts"]}）
```

## 必读背景

- **宿主**：pi（@earendil-works/pi-coding-agent）。扩展通过 `pi.on(事件)` 挂钩，API 类型来自 `@earendil-works/pi-coding-agent` 的 `ExtensionAPI` / `ExtensionContext`。
- **终端**：tty7 是一个开源终端。本扩展**只在 `process.env.TTY7` 存在时激活**（与 tty7 官方 hook `~/.pi/agent/extensions/tty7` 的守卫约定一致）。
- **两条通道分工**：会话状态/通知走 tty7 官方 agent-hook bridge；本扩展只负责"命名 + Tab 标题"，标题走 **OSC 转义序列**（tty7 的 CLI 没有设置 pane 标题的命令，这是验证过的结论）。
- 本地开发用 `pi -e .` 试用（不写配置）；正式安装走 `pi install`，settings.json 的 `packages` 里以相对路径引用。

## 关键约定与坑（改代码前必读）

0. **tty7 有两个二进制**：`/Applications/tty7.app/Contents/MacOS/tty7`（CLI，即 `/usr/local/bin/tty7`，支持 `tab ls --json`、`events --json`、`tab rename`）和 `tty7-app`（GUI bundle，只支持 `agent-hook` verb，其他命令静默返回空）。扩展用 `TTY7_CLI` 环境变量可覆盖，默认 `/usr/local/bin/tty7`。官方 bridge（`~/.pi/agent/extensions/tty7/index.ts`）用的 EXE 是 `tty7-app`——那是给 `agent-hook` 用的，别混用。

1. **标题最后一笔必须是本扩展写的纯 `{name}`**。pi 核心会在 `session_info_changed` 之后用 `π - {name} - {cwd}` 格式重写标题，且晚于扩展 handler。所以所有标题写入都经 `setTitleSoon()`（setTimeout 0 延迟一 tick）。标题格式用户明确要求**只显示 `{name}`**，不要加前后缀。
2. **命名是 fire-and-forget 并发**：在 `before_agent_start`（拿到 prompt 瞬间）就发小请求，不阻塞回合。不能等 `agent_end`——用户嫌那样反应慢，这是明确的产品决策。
3. **代数计数器 `gen`**：每次会话切换/退出 `gen++`。命名请求在途时若 gen 变了，结果必须丢弃，防止把名字写到别的会话上。
4. **手动命名判定**：`session_info_changed` 里 `event.name !== undefined` 即视为手动（用 `suppressInfo` 标志排除自己 set 触发的那次）。一旦 manual=true，自动命名对当前会话永久失效。
5. **上下文命名**：resume/fork 一个从未命名的会话时，取**最近 10 条用户消息**（`HISTORY_MESSAGES`，截断 2000 字符）为整个会话命名，不能只看追加的那条新消息——这是用户验证过的用例。
6. **失败静默 + 自动重试**：模型调用 20s 超时或出错时静默返回，靠 `before_agent_start` 在下一轮重试。不弹通知。
7. **session_shutdown** 时 `applyName(null)` 重置标题，Tab 回落 tty7 默认。
8. 标题模型输出必须过 `sanitizeTitle()`：取首个非空行、去引号/书名号/尾标点、截断 20 字符。
9. **双向同步**：`tty7 events --json` 常驻子进程监听 `tab_renamed`（只在用户手动改名时发出；OSC 标题写入走 `pane_facts.osc_title`→tab label，不会触发 rename 事件，故无回环）。pane→tab 映射用 `$TTY7_PANE` 反查 `tab ls --json`，事件 tab id 对不上时惰性重查。收到匹配改名 → `manual=true`（与 `/name` 同优先级）→ `setSessionName`。空名/同名 no-op。`session_shutdown` 杀子进程，进程崩溃静默、下次 session_start 重启。

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

## 当前状态 / 待办

- [x] package.json 与 README 中的旧名 `tty7-tab-sync` 统一改为 `pi-tty7-tab-namer`（含 repository URL）
- [ ] 发布前完整 code review
- [ ] push 到 GitHub（ifyour 账号），README 安装命令同步更新

## 风格

- 单文件、零配置、零依赖（peerDependencies 仅为类型）。能不加配置项就不加。
- 默认简体中文交流与文档；代码注释英文。
