// Claude model availability watcher (Cloudflare Worker).
//
// Source of truth: the official Anthropic status page
// (https://status.claude.com/api/v2/incidents/unresolved.json).
//
// The watched model is treated as UNAVAILABLE while an unresolved incident whose
// text matches the configured pattern exists. When that incident is resolved and
// leaves the unresolved feed, the model is treated as AVAILABLE again.
//
// The developer API is intentionally not used as the signal:
//   - GET /v1/models lists the model even when the product shows it as unavailable.
//   - POST /v1/messages requires credits and reflects the API surface, not the
//     product (Claude Code, claude.ai), which is what users actually see.
// The status feed is free, needs no key, and explicitly lists Claude Code as affected.

const STATUS_FEED = "https://status.claude.com/api/v2/incidents/unresolved.json";

// Defaults. Override WATCH_LABEL / WATCH_PATTERN via wrangler vars if needed.
const DEFAULTS = {
  label: "Fable 5",
  pattern: "fable\\s*5",
  heartbeatHours: 3, // remind that the model is still down on this cadence
  heartbeatPings: false, // whether the heartbeat mentions you (mobile push)
  confirmUp: 2, // consecutive "available" reads before announcing a recovery
  confirmDown: 1, // consecutive "unavailable" reads before announcing an outage
  unknownAlertChecks: 15, // consecutive failed status reads before warning once
};

const COLORS = { up: 0x2ecc71, down: 0xe67e22, blind: 0x95a5a6 };

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(tick(env));
  },

  // Helper endpoint for local development (wrangler dev):
  //   /?test=ping  sends a sample notification
  //   /            returns the current live reading as JSON
  async fetch(request, env) {
    const cfg = config(env);
    const url = new URL(request.url);
    if (url.searchParams.get("test") === "ping") {
      await send(env, {
        content: `<@${env.DISCORD_USER_ID}> Test notification`,
        mention: true,
        embeds: [{
          title: `${cfg.label} watcher`,
          description: "Webhook is working. This is a sample alert.",
          color: COLORS.up,
        }],
      });
      return json({ ok: true, action: "test-ping" });
    }
    return json(await checkStatus(cfg.regex));
  },
};

// Detection. Returns { state: "up" | "down" | "unknown", incident: {...} | null }.
export async function checkStatus(regex, attempts = 2) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(STATUS_FEED, { headers: { "user-agent": "claude-model-watcher" } });
      if (!res.ok) continue;
      const data = await res.json();
      const hit = (data.incidents || []).find((incident) => {
        const text = (incident.name || "") + " " +
          (incident.incident_updates || []).map((u) => u.body || "").join(" ");
        return incident.status !== "resolved" && regex.test(text);
      });
      if (hit) {
        return { state: "down", incident: { name: hit.name, startedAt: hit.started_at, url: hit.shortlink } };
      }
      return { state: "up", incident: null };
    } catch (err) {
      console.log(`status fetch failed (attempt ${i + 1}): ${err}`);
    }
  }
  return { state: "unknown", incident: null };
}

// Pure state machine. No I/O, fully unit testable.
// Given the current reading and the previous persisted state, returns the next
// state and the notifications that should be sent.
export function decide({ reading, prev, now, cfg }) {
  const s = { ...prev };
  const out = [];

  if (reading === "unknown") {
    s.unknownStreak = Math.min(prev.unknownStreak + 1, cfg.unknownAlertChecks);
    if (s.unknownStreak >= cfg.unknownAlertChecks && prev.unknownAlerted !== 1) {
      out.push("blind");
      s.unknownAlerted = 1;
    }
    return { state: s, notifications: out };
  }

  // Reading is known again.
  s.unknownStreak = 0;
  s.unknownAlerted = 0;

  // Streaks are capped at their confirmation thresholds so that a steady state
  // serializes to the same value every run, which lets the Worker skip KV writes.
  if (reading === "up") {
    s.upStreak = Math.min(prev.upStreak + 1, cfg.confirmUp);
    s.downStreak = 0;
  } else {
    s.downStreak = Math.min(prev.downStreak + 1, cfg.confirmDown);
    s.upStreak = 0;
  }

  let desired = null;
  if (reading === "up" && s.upStreak >= cfg.confirmUp) desired = "up";
  else if (reading === "down" && s.downStreak >= cfg.confirmDown) desired = "down";
  if (desired === null) return { state: s, notifications: out }; // wait for confirmation

  if (desired !== prev.status) {
    if (desired === "up") {
      out.push("up");
    } else if (prev.status === "up") {
      out.push("down");
      s.lastDownPing = now;
    } else {
      out.push("armed");
      s.lastDownPing = now;
    }
    s.status = desired;
    return { state: s, notifications: out };
  }

  if (desired === "down" && now - prev.lastDownPing >= cfg.heartbeatMs) {
    out.push("heartbeat");
    s.lastDownPing = now;
  }
  return { state: s, notifications: out };
}

// Worker wiring: read state, decide, persist, notify.
async function tick(env) {
  const cfg = config(env);
  const { state: reading, incident } = await checkStatus(cfg.regex);

  const kv = env.FABLE_STATE;
  const raw = await kv.get("state");
  const prev = raw ? JSON.parse(raw) : await migrateState(kv);

  const now = Date.now();
  const { state, notifications } = decide({ reading, prev, now, cfg });

  // Persist only when the state actually changes. With capped streaks a steady
  // state serializes identically every run, so this keeps daily KV writes far
  // below the free tier limit (1000 per day) instead of writing on every tick.
  const next = JSON.stringify(state);
  if (next !== raw) await kv.put("state", next);

  for (const kind of notifications) {
    await send(env, buildMessage(kind, { cfg, env, incident, now, blindChecks: state.unknownStreak }));
  }
}

// Reads the previous per-key layout once so upgrading does not re-announce.
async function migrateState(kv) {
  return {
    status: (await kv.get("status")) || "",
    upStreak: int(await kv.get("upStreak")),
    downStreak: int(await kv.get("downStreak")),
    lastDownPing: int(await kv.get("lastDownPing")),
    unknownStreak: int(await kv.get("unknownStreak")),
    unknownAlerted: int(await kv.get("unknownAlerted")),
  };
}

export function buildMessage(kind, { cfg, env, incident, now, blindChecks }) {
  const id = env.DISCORD_USER_ID;
  const link = incident && incident.url ? incident.url : undefined;
  const source = { text: "Source: status.claude.com" };
  const downSince = incident && incident.startedAt
    ? `Down for ${humanDuration(now - Date.parse(incident.startedAt))}`
    : undefined;

  switch (kind) {
    case "up":
      return {
        content: `<@${id}> ${cfg.label} is available again`,
        mention: true,
        embeds: [{
          title: `${cfg.label} is available again`,
          description: "The incident on the Claude status page has been resolved.",
          color: COLORS.up, footer: source, timestamp: iso(now),
        }],
      };
    case "down":
      return {
        content: `<@${id}> ${cfg.label} is unavailable again`,
        mention: true,
        embeds: [{
          title: `${cfg.label} is unavailable again`,
          description: incident ? incident.name : undefined,
          url: link, color: COLORS.down, footer: source, timestamp: iso(now),
        }],
      };
    case "armed":
      return {
        content: `<@${id}> ${cfg.label} watcher armed`,
        mention: true,
        embeds: [{
          title: `${cfg.label} is currently unavailable`,
          description: incident ? incident.name : "Watching for recovery.",
          url: link, color: COLORS.down, footer: source, timestamp: iso(now),
          fields: downSince ? [{ name: "Status", value: downSince }] : undefined,
        }],
      };
    case "heartbeat":
      return {
        content: cfg.heartbeatPings ? `<@${id}> ${cfg.label} still unavailable` : `${cfg.label} still unavailable`,
        mention: cfg.heartbeatPings,
        embeds: [{
          title: `${cfg.label} still unavailable`,
          description: downSince, url: link, color: COLORS.down, footer: source, timestamp: iso(now),
        }],
      };
    case "blind":
      return {
        content: "",
        mention: false,
        embeds: [{
          title: "Claude status page unreachable",
          description: `Could not read the status feed for ${blindChecks} consecutive checks. Detection is paused until it recovers.`,
          color: COLORS.blind, footer: source, timestamp: iso(now),
        }],
      };
    default:
      return { content: "", mention: false, embeds: [] };
  }
}

export function webhookBody(msg, env) {
  const body = {
    content: msg.content || "",
    allowed_mentions: msg.mention && env.DISCORD_USER_ID
      ? { parse: [], users: [env.DISCORD_USER_ID] }
      : { parse: [] },
  };
  if (msg.embeds && msg.embeds.length) body.embeds = msg.embeds;
  return body;
}

async function send(env, msg) {
  if (!env.DISCORD_WEBHOOK_URL) {
    console.log("DISCORD_WEBHOOK_URL is not set, skipping notification");
    return;
  }
  const res = await fetch(env.DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(webhookBody(msg, env)),
  });
  if (!res.ok) console.log(`Discord webhook returned ${res.status}: ${await res.text()}`);
}

function config(env) {
  const heartbeatHours = num(env && env.HEARTBEAT_HOURS, DEFAULTS.heartbeatHours);
  return {
    label: (env && env.WATCH_LABEL) || DEFAULTS.label,
    regex: new RegExp((env && env.WATCH_PATTERN) || DEFAULTS.pattern, "i"),
    heartbeatMs: heartbeatHours * 60 * 60 * 1000,
    heartbeatHours,
    heartbeatPings: bool(env && env.HEARTBEAT_PINGS, DEFAULTS.heartbeatPings),
    confirmUp: num(env && env.CONFIRM_UP, DEFAULTS.confirmUp),
    confirmDown: num(env && env.CONFIRM_DOWN, DEFAULTS.confirmDown),
    unknownAlertChecks: num(env && env.UNKNOWN_ALERT_CHECKS, DEFAULTS.unknownAlertChecks),
  };
}

function humanDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (!d && m) parts.push(`${m}m`);
  return parts.join(" ") || "0m";
}

const int = (v) => parseInt(v || "0", 10) || 0;
const num = (v, dflt) => (v === undefined || v === null || v === "" ? dflt : Number(v));
const bool = (v, dflt) => (v === undefined || v === null || v === "" ? dflt : String(v) === "true");
const iso = (ms) => new Date(ms).toISOString();

function json(obj) {
  return new Response(JSON.stringify(obj, null, 2), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
