# pi-tty7-tab-sync

**pi 扩展**：用大模型自动为会话命名，并把名字同步到 [tty7](https://github.com/l0ng-ai/tty7) 的 Tab 标题上。手动 `/name` 永远优先。

在 tty7 里开十个 pi 会话，每个 Tab 是什么任务一目了然——不需要点进去看。

```
Tab 1: 调试tty7标签同步    Tab 2: 重构用户服务    Tab 3: 修复登录空白页
```

## 特性

- **自动命名**：会话第一条消息发出时，并行调用当前会话模型总结意图，生成 ≤10 字中文标题，不阻塞对话
- **上下文感知**：载入一个从未命名的历史会话时，基于最近 10 条用户消息为**整个会话**命名，而不是只看追加的新消息
- **手动优先**：`/name 自定义名字` 之后，自动命名永不覆盖
- **全生命周期同步**：`new` / `resume` / `fork` / `quit` 时 Tab 标题跟随会话名字，退出后 Tab 回落到 tty7 默认
- **竞态安全**：命名请求在途时切换/退出会话，结果会被丢弃，不会写错会话；模型调用带 20 秒超时，失败后下一轮自动重试
- **零配置**：使用当前会话模型，无任何配置项

## 安装

前提：在 [tty7](https://github.com/l0ng-ai/tty7) 终端内运行 pi（本扩展只在 `TTY7` 环境变量存在时激活）。

```bash
pi install git:github.com/ifyour/tty7-tab-sync
```

或从 npm（已发布时）：

```bash
pi install npm:pi-tty7-tab-sync
```

或本地试用（不写入配置，仅本次生效）：

```bash
pi -e /path/to/tty7-tab-sync
```

> 如果你之前手动装过 `~/.pi/agent/extensions/tty7-tab-name.ts`，请先删除，避免重复加载。

## 使用

无需任何操作。装好后：

| 场景 | 行为 |
|---|---|
| 新会话发出第一条消息 | 几秒内 Tab 自动显示标题 |
| 载入未命名的历史会话 | 立即基于历史上下文命名 |
| `/name 自定义` | Tab 立即更新，且之后自动命名不再生效 |
| resume 已命名会话 | Tab 立即显示该名字 |
| 退出 pi | Tab 回落到 tty7 默认 |

名字会同步写入会话元数据（`/name` 和会话选择器里看到的是同一个名字），`/resume` 列表中也直接可读。

## 工作原理

- **命名**：`before_agent_start` / `session_start(resume)` 时 fire-and-forget 一个小请求（`maxTokens: 512`，prompt 截断 2000 字符），生成标题后经 `sanitizeTitle` 清洗（去引号/书名号/多行/超长截断）再落盘
- **标题通道**：直接写 OSC 转义序列（`\x1B]0;{name}\x07`）。pi 核心会在 `session_info_changed` 之后以 `π - {name} - {cwd}` 格式重写标题，本扩展延迟一个 tick 再写，保证最后一笔是纯 `{name}`
- **与 tty7 的 agent hook 并存**：状态点/通知/断电恢复走 tty7 官方装的 pi hook（`~/.pi/agent/extensions/tty7`），本扩展只负责命名与标题，互不干扰

## 开发

```bash
git clone https://github.com/ifyour/tty7-tab-sync
cd tty7-tab-sync
npm test          # 标题清洗逻辑自检
pi -e .           # 本地试用
```

## FAQ

**在其他终端（iTerm2 等）能用吗？**
目前不能——激活条件是 `TTY7` 环境变量（与 tty7 官方 hook 的守卫一致）。想在任意终端生效，删掉 `extensions/tty7-tab-name.ts` 顶部的守卫行即可。

**支持多轮后自动改名吗？**
目前一个会话只命名一次（手动除外）。想要随对话演进改名，在 `agent_end` 加节流重命名即可，欢迎 PR。

**模型调用花钱吗？**
每次命名一个极小请求（约几百 token），仅未命名会话的首次触发时发生。

## License

MIT
