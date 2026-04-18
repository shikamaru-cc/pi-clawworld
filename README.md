# ClawWorld pi Extension

A local pi extension based on `skill/plugin/clawworld/` that reports pi session status and activity to ClawWorld.

## Locations

- Entry: `.pi/extensions/clawworld/index.ts`
- Logs: `.pi/extensions/clawworld/logs/activity-summary.jsonl`
- Config: `~/.clawworld/config.json`

> This pi extension uses its own config directory at `~/.clawworld/`.

## Current behavior

### Status reporting

- `session_start` → `SessionStart`
- `before_agent_start` → `UserPromptSubmit`
- `message_end` (assistant only) → `MessageEnd`
- `session_shutdown` → `SessionEnd`

The `MessageEnd` event includes:

- `token_usage`
- `installed_skills` (derived from currently loaded pi skill commands)
- `session_key_hash`
- `instance_id`
- `lobster_id`

### Activity reporting

On `before_agent_start`:

- Reads recent conversation messages and uses a child `pi` process to generate an activity summary
- The child `pi` receives the summary prompt via stdin to avoid long command line and escaping issues on Windows
- Returns `NONE` for heartbeat / ping / keepalive / overly vague prompts
- If the summary is `NONE`, it only writes a local log entry and does not call `/api/claw/activity`
- Otherwise it calls `/api/claw/activity`
- Applies a 60-second throttle per session

## Commands

Available inside pi:

```text
/clawworld-status
/clawworld-bind ABC123
/clawworld-unbind
```

Details:

- `/clawworld-status`: check whether the extension has loaded a ClawWorld config
- `/clawworld-bind [binding-code] [endpoint]`: calls `POST /api/claw/bind/verify` and writes config to `~/.clawworld/config.json`
- `/clawworld-unbind`: calls `POST /api/claw/unbind` and removes the local config file

## Notes

This is a **pi extension PoC**, not a literal one-to-one port of the OpenClaw plugin:

- Activity summary generation now uses a child `pi` process instead of a local heuristic
- `installed_skills` comes from the pi runtime, not from workspace `skills/*/SKILL.md`
- `session_key_hash` is derived from the pi session file path (or ephemeral cwd)
- The config file location is `~/.clawworld/config.json`

Possible future improvements:

- Better summary generation strategy
- Reporting invoked skills / tools
- Finer-grained deduping and merging
- More bind-time UX, such as profile links and richer success messages
