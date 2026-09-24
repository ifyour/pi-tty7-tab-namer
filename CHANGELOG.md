# Changelog

## 0.0.2 - 2026-09-25

### 修复

- `/new` 现在会完整重置 Tab：即使当前 Tab 名来自 tty7 里的手动改名（反向同步），`/new` 也会清空 `name` 字段、回落 tty7 默认标题，进入下一个完整命名周期。此前只有扩展自己写的名字（自动命名 / `/name`）才会在切换会话时被清掉，手动改的 Tab 名会残留到新会话。其他场景（resume / fork / 退出 pi）行为不变：用户手改的名字仍然永久保留。

### 改进

- 反向同步生效时弹出通知：在 tty7 里手动改 Tab 名后，pi 内显示 `Session name set: <名字>`，同步结果可感知。
- 切换到不同 Tab（resume / 移动 pane）时重置 `appliedTabName` 缓存，避免向新 Tab 发出冗余的 rename。
