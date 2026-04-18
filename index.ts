import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

type ClawWorldConfig = {
  deviceToken: string;
  lobsterId: string;
  instanceId: string;
  endpoint: string;
};

type StatusPayload = {
  instance_id: string;
  lobster_id: string;
  event_type: string;
  event_action: string;
  timestamp: string;
  session_key_hash: string;
  installed_skills?: string[];
  token_usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
};

type ActivityPayload = {
  instance_id: string;
  lobster_id: string;
  activity_at: string;
  activity_id: string;
  session_key_hash: string;
  kind: string;
  summary: string;
};

const CONFIG_DIR = path.join(os.homedir(), ".clawworld");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const MIN_ACTIVITY_PUSH_INTERVAL_MS = 60_000;
const NO_ACTIVITY = "NONE";

function truncate(value: string, max = 160): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, max - 1)}…`;
}

function hashSessionKey(sessionKey: string): string {
  return crypto.createHash("sha256").update(sessionKey).digest("hex").slice(0, 16);
}

function buildActivityId(params: {
  lobsterId: string;
  activityAt: string;
  sessionKeyHash: string;
  kind: string;
  summary: string;
}): string {
  const raw = [
    params.lobsterId,
    params.activityAt,
    params.sessionKeyHash,
    params.kind,
    params.summary,
  ].join("|");
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 32);
}

function resolveSessionKey(ctx: ExtensionContext): string {
  return ctx.sessionManager.getSessionFile() ?? `ephemeral:${ctx.cwd}`;
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) => {
      if (!part || typeof part !== "object") {
        return "";
      }
      const record = part as { type?: unknown; text?: unknown };
      if (record.type === "text" && typeof record.text === "string") {
        return record.text;
      }
      return "";
    })
    .filter(Boolean)
    .join(" ");
}

function extractMessageRole(message: unknown): string {
  if (!message || typeof message !== "object") {
    return "unknown";
  }
  const role = (message as { role?: unknown }).role;
  return typeof role === "string" ? role : "unknown";
}

function extractMessagePreview(message: unknown, max = 140): string {
  const role = extractMessageRole(message);
  const text = truncate(extractTextContent((message as { content?: unknown })?.content ?? ""), max);
  return `${role}: ${text || "<empty>"}`;
}

function getRecentMessages(ctx: ExtensionContext, limit = 8): Array<{ role: string; content: string }> {
  const messages = ctx.sessionManager
    .getBranch()
    .filter((entry) => entry.type === "message")
    .map((entry) => entry.message)
    .filter((message) => {
      const role = extractMessageRole(message);
      return role === "user" || role === "assistant";
    })
    .slice(-limit)
    .map((message) => ({
      role: extractMessageRole(message),
      content: truncate(extractTextContent((message as { content?: unknown })?.content ?? ""), 800),
    }));

  return messages;
}

function getRecentContext(ctx: ExtensionContext, limit = 4): string {
  const contextLines = getRecentMessages(ctx, limit).map(
    (message, index) => `${index + 1}. ${message.role}: ${message.content || "<empty>"}`,
  );
  return contextLines.length > 0 ? contextLines.join("\n") : "<none>";
}

function normalizePrompt(prompt: string): string {
  return prompt
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

async function runChildPi(prompt: string, signal?: AbortSignal): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child =
      process.platform === "win32"
        ? spawn("cmd.exe", ["/d", "/s", "/c", "pi.cmd -p --no-extensions --no-skills --no-prompt-templates --no-context-files"], {
            stdio: ["pipe", "pipe", "pipe"],
          })
        : spawn("pi", ["-p", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files"], {
            stdio: ["pipe", "pipe", "pipe"],
          });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
    };

    const finish = (value: { code: number | null; stdout: string; stderr: string }) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(value);
    };

    const fail = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };

    const onAbort = () => {
      child.kill();
      fail(new Error("child pi aborted"));
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }

    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      fail(error instanceof Error ? error : new Error(String(error)));
    });
    child.on("close", (code) => {
      finish({ code, stdout, stderr });
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

async function summarizeActivityWithChildPi(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  prompt: string,
): Promise<string> {
  const normalizedPrompt = normalizePrompt(prompt);
  if (!normalizedPrompt) {
    return NO_ACTIVITY;
  }

  const recentMessages = getRecentMessages(ctx, 8);
  const latestUserMessage = [...recentMessages].reverse().find((message) => message.role === "user");
  const recentTranscript = recentMessages.length
    ? recentMessages
        .map((message, index) => `${index + 1}. ${message.role}: ${message.content || "<empty>"}`)
        .join("\n")
    : "<none>";

  const childPrompt = [
    "You are generating a short, safe activity summary for a coding session.",
    "Decide whether the LATEST_USER_MESSAGE indicates a real, concrete work topic.",
    "Requirements:",
    "- Output only plain text.",
    `- If there is no clear, concrete work topic, output exactly ${NO_ACTIVITY}.`,
    "- Output exactly NONE if the latest user message is a heartbeat, ping, pong, keepalive, health check, probe, connection test, or similar non-work message.",
    "- Output exactly NONE if the latest user message is too vague, transitional, meta-only, or cannot be understood confidently.",
    "- Do NOT infer the task from older context alone.",
    "- RECENT_TRANSCRIPT is only supporting evidence; the latest user message must itself justify the activity.",
    "- Otherwise output exactly 1 short sentence, ideally under 140 characters.",
    "- Do not include secrets, credentials, or long quotes.",
    "- Do not explain your reasoning.",
    "",
    "LATEST_USER_MESSAGE:",
    latestUserMessage ? `${latestUserMessage.role}: ${latestUserMessage.content}` : "<missing>",
    "",
    "RECENT_TRANSCRIPT:",
    recentTranscript,
    "",
    "CURRENT_PROMPT:",
    normalizedPrompt,
  ].join("\n");

  const result = await runChildPi(childPrompt, ctx.signal);

  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `child pi exited with code ${result.code}`);
  }

  const output = result.stdout.trim();
  if (!output) {
    throw new Error("child pi returned empty summary");
  }

  return truncate(output.split(/\r?\n/).find(Boolean) ?? output, 280);
}

function collectInstalledSkills(pi: ExtensionAPI): string[] | undefined {
  const skills = pi
    .getCommands()
    .filter((command) => command.source === "skill")
    .map((command) => {
      if (command.name.startsWith("skill:")) {
        return command.name.slice("skill:".length).trim();
      }
      const fromPath = path.basename(path.dirname(command.sourceInfo.path));
      return fromPath.trim();
    })
    .filter(Boolean);

  if (skills.length === 0) {
    return undefined;
  }

  return [...new Set(skills)].sort();
}

function getUsageFromAssistantMessage(message: unknown): { input?: number; output?: number } | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }

  const record = message as {
    role?: unknown;
    usage?: {
      input?: number;
      output?: number;
    };
  };

  if (record.role !== "assistant" || !record.usage) {
    return undefined;
  }

  if (record.usage.input == null && record.usage.output == null) {
    return undefined;
  }

  return {
    input: record.usage.input,
    output: record.usage.output,
  };
}

function normalizeConfig(parsed: Partial<ClawWorldConfig>): ClawWorldConfig | null {
  if (
    typeof parsed.deviceToken !== "string" ||
    !parsed.deviceToken.trim() ||
    typeof parsed.lobsterId !== "string" ||
    !parsed.lobsterId.trim() ||
    typeof parsed.instanceId !== "string" ||
    !parsed.instanceId.trim() ||
    typeof parsed.endpoint !== "string" ||
    !parsed.endpoint.trim()
  ) {
    return null;
  }

  return {
    deviceToken: parsed.deviceToken.trim(),
    lobsterId: parsed.lobsterId.trim(),
    instanceId: parsed.instanceId.trim(),
    endpoint: parsed.endpoint.trim().replace(/\/+$/, ""),
  };
}

async function loadClawWorldConfig(): Promise<ClawWorldConfig | null> {
  try {
    const raw = await fs.readFile(CONFIG_FILE, "utf8");
    return normalizeConfig(JSON.parse(raw) as Partial<ClawWorldConfig>);
  } catch {
    return null;
  }
}

async function saveClawWorldConfig(config: ClawWorldConfig): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.writeFile(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

async function deleteClawWorldConfig(): Promise<void> {
  await fs.rm(CONFIG_FILE, { force: true });
}

function createInstanceId(): string {
  return crypto.createHash("sha256").update(os.hostname()).digest("hex").slice(0, 32);
}

async function postStatus(config: ClawWorldConfig, payload: StatusPayload): Promise<void> {
  const response = await fetch(`${config.endpoint}/api/claw/status`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.deviceToken}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(5_000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`status POST failed: ${response.status} ${text}`.trim());
  }
}

async function postActivity(config: ClawWorldConfig, payload: ActivityPayload): Promise<void> {
  const response = await fetch(`${config.endpoint}/api/claw/activity`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.deviceToken}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(5_000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`activity POST failed: ${response.status} ${text}`.trim());
  }
}

async function appendJsonlLine(filePath: string, record: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(record)}\n`, "utf8");
}

async function resolveLogsDir(ctx: ExtensionContext): Promise<string> {
  const logsDir = path.join(ctx.cwd, ".pi", "extensions", "clawworld", "logs");
  await fs.mkdir(logsDir, { recursive: true });
  return logsDir;
}

export default function clawworldExtension(pi: ExtensionAPI) {
  let clawWorldConfig: ClawWorldConfig | null = null;
  const inFlightActivitySessions = new Set<string>();
  const lastActivityPushAtBySession = new Map<string, number>();

  async function ensureConfig(): Promise<ClawWorldConfig | null> {
    if (clawWorldConfig) {
      return clawWorldConfig;
    }
    clawWorldConfig = await loadClawWorldConfig();
    return clawWorldConfig;
  }

  async function pushLifecycleStatus(ctx: ExtensionContext, eventAction: string): Promise<void> {
    const sessionKey = resolveSessionKey(ctx);
    const config = await ensureConfig();
    if (!config) {
      return;
    }

    const payload: StatusPayload = {
      instance_id: config.instanceId,
      lobster_id: config.lobsterId,
      event_type: "pi",
      event_action: eventAction,
      timestamp: new Date().toISOString(),
      session_key_hash: hashSessionKey(sessionKey),
    };

    await postStatus(config, payload);
  }

  async function handleActivityPush(ctx: ExtensionContext, prompt: string): Promise<void> {
    const sessionKey = resolveSessionKey(ctx);
    const config = await ensureConfig();
    if (!config) {
      return;
    }

    const now = Date.now();
    const lastPushAt = lastActivityPushAtBySession.get(sessionKey) ?? 0;
    if (now - lastPushAt < MIN_ACTIVITY_PUSH_INTERVAL_MS) {
      return;
    }

    if (inFlightActivitySessions.has(sessionKey)) {
      return;
    }

    inFlightActivitySessions.add(sessionKey);
    try {
      const summary = await summarizeActivityWithChildPi(pi, ctx, prompt);
      const logsDir = await resolveLogsDir(ctx);
      const outputFile = path.join(logsDir, "activity-summary.jsonl");
      const activityAt = new Date().toISOString();
      const sessionKeyHash = hashSessionKey(sessionKey);
      const recentContext = getRecentContext(ctx);
      const kind = "other";

      if (summary === NO_ACTIVITY) {
        await appendJsonlLine(outputFile, {
          ts: activityAt,
          sessionKey,
          sessionKeyHash,
          prompt: truncate(normalizePrompt(prompt), 240),
          recentContext,
          summary,
          posted: false,
          skippedReason: "no_clear_work_topic",
        });
        return;
      }

      const activityId = buildActivityId({
        lobsterId: config.lobsterId,
        activityAt,
        sessionKeyHash,
        kind,
        summary,
      });

      await postActivity(config, {
        instance_id: config.instanceId,
        lobster_id: config.lobsterId,
        activity_at: activityAt,
        activity_id: activityId,
        session_key_hash: sessionKeyHash,
        kind,
        summary,
      });
      lastActivityPushAtBySession.set(sessionKey, Date.now());

      await appendJsonlLine(outputFile, {
        ts: activityAt,
        sessionKey,
        sessionKeyHash,
        prompt: truncate(normalizePrompt(prompt), 240),
        recentContext,
        summary,
        activityId,
        posted: true,
      });
    } finally {
      inFlightActivitySessions.delete(sessionKey);
    }
  }

  pi.registerCommand("clawworld-status", {
    description: "Show whether the current pi session is connected to ClawWorld",
    handler: async (_args, ctx) => {
      const config = await ensureConfig();
      if (!config) {
        ctx.ui.notify(`ClawWorld not configured (${CONFIG_FILE})`, "warning");
        return;
      }
      ctx.ui.notify(`ClawWorld bound: lobster=${config.lobsterId} instance=${config.instanceId}`, "info");
    },
  });

  pi.registerCommand("clawworld-bind", {
    description: "Bind this pi instance to ClawWorld (usage: /clawworld-bind [binding-code] [endpoint])",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      let bindingCode = parts[0];
      let endpoint = parts[1] ?? "https://api.claw-world.app";

      if (!bindingCode && ctx.hasUI) {
        bindingCode = await ctx.ui.input("ClawWorld binding code:", "6-character code") ?? "";
      }

      if (!bindingCode) {
        ctx.ui.notify("Missing binding code", "warning");
        return;
      }

      bindingCode = bindingCode.trim().toUpperCase();
      endpoint = endpoint.trim().replace(/\/+$/, "");
      const instanceId = createInstanceId();

      try {
        const response = await fetch(`${endpoint}/api/claw/bind/verify`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            binding_code: bindingCode,
            instance_id: instanceId,
          }),
          signal: AbortSignal.timeout(10_000),
        });

        const body = (await response.json().catch(() => ({}))) as {
          lobster_id?: unknown;
          lobster_name?: unknown;
          device_token?: unknown;
          error?: unknown;
        };

        if (!response.ok) {
          const message = typeof body.error === "string" ? body.error : `HTTP ${response.status}`;
          throw new Error(message);
        }

        const config = normalizeConfig({
          deviceToken: typeof body.device_token === "string" ? body.device_token : "",
          lobsterId: typeof body.lobster_id === "string" ? body.lobster_id : "",
          instanceId,
          endpoint,
        });

        if (!config) {
          throw new Error("bind response missing required fields");
        }

        await saveClawWorldConfig(config);
        clawWorldConfig = config;

        if (ctx.hasUI) {
          ctx.ui.setStatus("clawworld", `🌍 ClawWorld ${config.lobsterId}`);
        }

        const lobsterName = typeof body.lobster_name === "string" && body.lobster_name.trim()
          ? body.lobster_name.trim()
          : config.lobsterId;
        ctx.ui.notify(`🌍 Bound to ClawWorld: ${lobsterName}`, "info");
      } catch (error) {
        ctx.ui.notify(
          `ClawWorld bind failed: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });

  pi.registerCommand("clawworld-unbind", {
    description: "Unbind this pi instance from ClawWorld",
    handler: async (_args, ctx) => {
      const config = await ensureConfig();
      if (!config) {
        ctx.ui.notify(`ClawWorld not configured (${CONFIG_FILE})`, "warning");
        return;
      }

      try {
        const response = await fetch(`${config.endpoint}/api/claw/unbind`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.deviceToken}`,
          },
          body: JSON.stringify({
            instance_id: config.instanceId,
          }),
          signal: AbortSignal.timeout(10_000),
        });

        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { error?: unknown };
          const message = typeof body.error === "string" ? body.error : `HTTP ${response.status}`;
          throw new Error(message);
        }

        await deleteClawWorldConfig();
        clawWorldConfig = null;
        if (ctx.hasUI) {
          ctx.ui.setStatus("clawworld", "🌍 ClawWorld unbound");
        }
        ctx.ui.notify("Disconnected from ClawWorld.", "info");
      } catch (error) {
        ctx.ui.notify(
          `ClawWorld unbind failed: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });

  pi.on("session_start", async (event, ctx) => {
    const config = await ensureConfig();
    if (ctx.hasUI) {
      ctx.ui.setStatus("clawworld", config ? `🌍 ClawWorld ${config.lobsterId}` : "🌍 ClawWorld unbound");
    }

    if (event.reason === "reload") {
      return;
    }

    if (!config) {
      return;
    }

    try {
      await pushLifecycleStatus(ctx, "SessionStart");
    } catch (error) {
      ctx.ui.notify(
        `ClawWorld SessionStart failed: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const config = await ensureConfig();
    if (!config) {
      return;
    }

    try {
      await pushLifecycleStatus(ctx, "SessionEnd");
    } catch (error) {
      ctx.ui.notify(
        `ClawWorld SessionEnd failed: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const sessionKey = resolveSessionKey(ctx);
    const config = await ensureConfig();
    if (!config) {
      return;
    }

    const payload: StatusPayload = {
      instance_id: config.instanceId,
      lobster_id: config.lobsterId,
      event_type: "pi",
      event_action: "UserPromptSubmit",
      timestamp: new Date().toISOString(),
      session_key_hash: hashSessionKey(sessionKey),
    };

    try {
      await postStatus(config, payload);
    } catch (error) {
      ctx.ui.notify(
        `ClawWorld UserPromptSubmit failed: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
    }

    void handleActivityPush(ctx, event.prompt).catch((error) => {
      ctx.ui.notify(
        `ClawWorld activity upload failed: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
    });
  });

  pi.on("message_end", async (event, ctx) => {
    const sessionKey = resolveSessionKey(ctx);
    const config = await ensureConfig();
    if (!config) {
      return;
    }

    const usage = getUsageFromAssistantMessage(event.message);
    if (!usage || (usage.input == null && usage.output == null)) {
      return;
    }

    const installedSkills = collectInstalledSkills(pi);

    const payload: StatusPayload = {
      instance_id: config.instanceId,
      lobster_id: config.lobsterId,
      event_type: "pi",
      event_action: "MessageEnd",
      timestamp: new Date().toISOString(),
      session_key_hash: hashSessionKey(sessionKey),
      ...(installedSkills?.length ? { installed_skills: installedSkills } : {}),
      token_usage: {
        ...(usage.input != null ? { input_tokens: usage.input } : {}),
        ...(usage.output != null ? { output_tokens: usage.output } : {}),
      },
    };

    try {
      await postStatus(config, payload);
    } catch (error) {
      ctx.ui.notify(
        `ClawWorld MessageEnd failed: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
    }
  });
}
