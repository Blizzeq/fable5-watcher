// Sends one sample of every notification type to your Discord webhook so you can
// see exactly what the watcher produces. Messages are tagged [demo] and do not
// ping you (the mention is rendered but notifications are suppressed).
//
// Usage:
//   DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/..." \
//   DISCORD_USER_ID="123456789012345678" \
//   npm run demo

import { buildMessage, webhookBody } from "../src/index.js";

const webhook = process.env.DISCORD_WEBHOOK_URL;
const userId = process.env.DISCORD_USER_ID;
if (!webhook || !userId) {
  console.error("Set DISCORD_WEBHOOK_URL and DISCORD_USER_ID in the environment.");
  process.exit(1);
}

const env = { DISCORD_USER_ID: userId };
const cfg = { label: "Fable 5", heartbeatHours: 3, heartbeatPings: false };
const now = Date.now();
const incident = {
  name: "We've suspended access to Claude Mythos 5 and Claude Fable 5",
  startedAt: "2026-06-13T00:50:43.823Z",
  url: "https://stspg.io/kqx0j625mrgv",
};

const kinds = ["armed", "down", "heartbeat", "up", "blind"];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

for (const kind of kinds) {
  const msg = buildMessage(kind, { cfg, env, incident, now, blindChecks: 15 });
  msg.content = "[demo] " + (msg.content || kind);
  msg.mention = false; // render the mention but do not push during a demo
  const res = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(webhookBody(msg, env)),
  });
  console.log(`${kind.padEnd(10)} -> ${res.status}`);
  await wait(800); // keep channel order and stay within webhook rate limits
}
