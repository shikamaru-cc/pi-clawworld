# ClawWorld pi Extension

基于 `~/.clawworld/config.json` 的本地 pi extension，实现 pi 会话状态上报与 activity summary。

## 位置

- 入口：`.pi/extensions/clawworld/index.ts`
- 日志：`.pi/extensions/clawworld/logs/activity-summary.jsonl`
- 配置：`~/.clawworld/config.json`

## 当前行为

### Status 上报

- `session_start` → `SessionStart`
- `before_agent_start` → `UserPromptSubmit`
- `message_end`（assistant only） → `MessageEnd`
- `session_shutdown` → `SessionEnd`

`MessageEnd` 事件会附带：

- `token_usage`
- `installed_skills`（从当前 pi 已加载的 skill commands 推导）
- `session_key_hash`
- `instance_id`
- `lobster_id`

### Activity Summary

在 `agent_end` 时 fire-and-forget：

- 读取最近对话消息，调用子 `pi -p` 进程生成 activity summary
- 参考 `agent_end` 提供的当前轮 `event.messages`，贴近"这轮实际完成了什么"
- 子 `pi` 通过 stdin 接收 summary prompt
- 设置 `--no-session --no-extensions --no-skills --no-prompt-templates --no-context-files` 实现完全隔离
- 对 heartbeat / ping / keepalive / 过于空泛的 prompt 返回 `NONE`
- `NONE` 时只写本地日志，不调用 `/api/claw/activity`
- 非 `NONE` 时调用 `/api/claw/activity`
- 150ms 延迟等待 transcript 落盘
- 按 session 做 60 秒节流
- 使用 `void` fire-and-forget，不阻塞用户

## 命令

当前 extension 不提供任何用户命令。

## 说明

这版是 **纯埋点型** extension：

- 不负责 bind / unbind（由 skill 侧负责）
- 不负责用户交互
- 只做 status / usage / activity 的自动上报
- `installed_skills` 来源于 pi runtime
- `session_key_hash` 使用 pi session file 路径（或 ephemeral cwd）做哈希
- 配置文件位置为 `~/.clawworld/config.json`
