# Fable 5 Watcher

A small Cloudflare Worker that checks the official Claude status page every 60 seconds and sends a Discord notification when Claude Fable 5 becomes available again. It runs entirely on the Cloudflare free tier, so no server or local machine has to stay on, and it needs no Anthropic API key or credits.

The watched model is configurable, so the same Worker can track any Claude model that appears on the status page. Fable 5 is the default.

## How it works

A Cron Trigger invokes the Worker once a minute. Each run does four things:

1. Reads the unresolved incident feed at `https://status.claude.com/api/v2/incidents/unresolved.json`.
2. Treats the model as unavailable while an unresolved incident matches the configured pattern (by default any incident text containing "Fable 5"), and as available once no such incident remains.
3. Compares that reading with the previous state stored in Workers KV.
4. Sends a Discord message only when the state changes, plus a periodic reminder while the model stays down.

## Why the status page instead of the API

The Anthropic developer API is not a reliable signal for product availability:

* `GET /v1/models` lists `claude-fable-5` even while Claude Code and claude.ai show it as unavailable, which produces false positives.
* `POST /v1/messages` requires credits and reflects the API surface rather than the product that users interact with.

The status page is public, needs no authentication, and explicitly names Claude Code and claude.ai as affected components, so it matches what users actually see in the product.

## Notifications

| Event | Behavior |
| --- | --- |
| Recovery (unavailable to available) | Mentions you for a mobile push. Needs `CONFIRM_UP` consecutive readings to avoid flapping. |
| Outage (available to unavailable) | Mentions you. |
| Still unavailable | A reminder every `HEARTBEAT_HOURS`, silent by default. |
| First run | An armed message describing the current state. |
| Status page unreachable | A single warning after repeated failures, then silence until it recovers. |
| Staying available | No message. |

Messages are sent as Discord embeds with a color and a link to the incident.

## Configuration

State and secrets aside, behavior is controlled by optional variables. Defaults are defined in `src/index.js`.

| Variable | Type | Default | Purpose |
| --- | --- | --- | --- |
| `DISCORD_WEBHOOK_URL` | secret | required | Incoming webhook for the target channel. |
| `DISCORD_USER_ID` | secret | required | Your Discord user id, used for the mention. |
| `WATCH_LABEL` | var | `Fable 5` | Display name used in messages. |
| `WATCH_PATTERN` | var | `fable\s*5` | Case insensitive regex matched against incident text. |
| `HEARTBEAT_HOURS` | var | `3` | Hours between "still unavailable" reminders. |
| `HEARTBEAT_PINGS` | var | `false` | Whether the reminder mentions you. |
| `CONFIRM_UP` | var | `2` | Consecutive available readings before announcing recovery. |
| `CONFIRM_DOWN` | var | `1` | Consecutive unavailable readings before announcing an outage. |
| `UNKNOWN_ALERT_CHECKS` | var | `15` | Failed status reads before the unreachable warning. |

## Setup

Prerequisites: a Cloudflare account, Node.js, and a Discord channel webhook.

```
npm install
npx wrangler login

# Create the KV namespace, then paste the returned id into wrangler.toml
npx wrangler kv namespace create FABLE_STATE

# Store the secrets
npx wrangler secret put DISCORD_WEBHOOK_URL
npx wrangler secret put DISCORD_USER_ID

# Deploy and register the cron trigger
npx wrangler deploy
```

To find your Discord user id, enable Developer Mode in Discord settings, then right click your name and choose Copy User ID. To create a webhook, open Server Settings, then Integrations, then Webhooks.

## Local development

```
cp .dev.vars.example .dev.vars   # fill in the values
npx wrangler dev
# open http://localhost:8787/?test=ping to send a sample alert
# open http://localhost:8787/ to see the current live reading
```

Inspect production state:

```
npx wrangler kv key get "status" --binding=FABLE_STATE --remote
npx wrangler tail
```

## Tests

The decision logic is a pure function with no I/O, covered by unit tests that run with the Node test runner and no external dependencies.

```
npm test
```

## Project layout

| Path | Purpose |
| --- | --- |
| `src/index.js` | Worker entry, status detection, state machine, Discord output |
| `test/decide.test.mjs` | Unit tests for the state machine |
| `wrangler.toml` | Cron schedule, KV binding, optional variables |
| `.github/workflows/ci.yml` | Runs the syntax check and tests on every push |

## License

MIT
