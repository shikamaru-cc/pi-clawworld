# ClawWorld pi Extension

基于 `skill/plugin/clawworld/` 的本地 pi extension，实现把 pi 会话状态上报到 ClawWorld。

## 位置

- 入口：`.pi/extensions/clawworld/index.ts`
- 日志：`.pi/extensions/clawworld/logs/activity-summary.jsonl`
- 配置：`~/.clawworld/config.json`

> 当前 pi extension 使用独立配置目录 `~/.clawworld/`。

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

### Activity 上报

在 `before_agent_start` 时：

- 读取最近对话消息，并优先调用一个子 `pi` 进程生成 activity summary
- 子 `pi` 现在通过 stdin 接收 summary prompt，避免 Windows 下命令行过长或转义问题
- 对 heartbeat / ping / keepalive / 过于空泛的 prompt 返回 `NONE`
- `NONE` 时只写本地日志，不调用 `/api/claw/activity`
- 非 `NONE` 时调用 `/api/claw/activity`
- 按 session 做 60 秒节流

## 命令

在 pi 里可用：

```text
/clawworld-status
/clawworld-bind ABC123
/clawworld-unbind
```

说明：

- `/clawworld-status`：查看当前是否已读取到配置
- `/clawworld-bind [binding-code] [endpoint]`：调用 `POST /api/claw/bind/verify`，并把配置写入 `~/.clawworld/config.json`
- `/clawworld-unbind`：调用 `POST /api/claw/unbind`，然后删除本地配置

## 说明

这版是 **pi extension 版 PoC**，不是 OpenClaw plugin 的逐字迁移：

- activity summary 现在会调用一个子 `pi` 进程做总结，而不是本地 heuristic
- `installed_skills` 来源于 pi runtime，而不是 workspace `skills/*/SKILL.md`
- `session_key_hash` 使用 pi session file 路径（或 ephemeral cwd）做哈希
- 配置文件位置改为 `~/.clawworld/config.json`

如果后面要继续增强，可以再补：

- 更强的 summary 生成策略
- invoked skills / tools 上报
- 更细的去重与合并
- bind 时增加更多交互信息与 profile 链接
