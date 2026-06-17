// Fable 5 availability watcher — Cloudflare Worker
//
// SYGNAŁ PRAWDY: oficjalna strona statusu Anthropic (status.claude.com).
// Fable 5 jest NIEDOSTĘPNY, dopóki istnieje nierozwiązany incydent dotyczący
// "Fable 5" (obecnie: "We've suspended access to Claude Mythos 5 and Claude Fable 5",
// status "monitoring", dotyczy m.in. Claude Code i claude.ai).
// Gdy ten incydent zniknie z listy nierozwiązanych (status -> resolved) => Fable 5 wraca.
//
// Dlaczego NIE /v1/models ani /v1/messages:
//   - /v1/models listuje claude-fable-5 nawet gdy w produkcie jest "unavailable" => fałszywy alarm,
//   - /v1/messages wymaga kredytów i dotyczy developerskiego API, nie produktu (Claude Code/claude.ai).
// Strona statusu jest darmowa, bez logowania i wprost wymienia Claude Code jako objęty incydentem.

// ── Ustawienia (śmiało zmieniaj) ─────────────────────────────────────────────
const HEARTBEAT_HOURS = 3;          // co ile godzin przypominać "wciąż niedostępny"
const HEARTBEAT_PINGS_YOU = false;  // czy heartbeat ma Cię @oznaczać (push). Powrót Fable 5 ZAWSZE pinguje.
const CONFIRM_UP_CHECKS = 2;        // ile kolejnych odczytów "dostępny" zanim ogłosimy powrót (anty-miganie)

const UNRESOLVED_URL = "https://status.claude.com/api/v2/incidents/unresolved.json";
const MATCH = /fable\s*5/i;
const HEARTBEAT_MS = HEARTBEAT_HOURS * 60 * 60 * 1000;

export default {
  // Cron Trigger co 60 s.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(tick(env));
  },

  // Pomocniczy endpoint do ręcznych testów (działa pod `wrangler dev`):
  //   /?test=ping -> wysyła testowe powiadomienie    /  -> zwraca aktualny odczyt
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.searchParams.get("test") === "ping") {
      await notify(env, `<@${env.DISCORD_USER_ID}> 🔔 Test fable5-watcher — webhook działa.`, true);
      return json({ ok: true, action: "test-ping" });
    }
    return json(await checkStatus());
  },
};

// ── Detekcja ─────────────────────────────────────────────────────────────────
// Zwraca { state: 'up' | 'down' | 'unknown', incident: {name, startedAt, url} | null }
export async function checkStatus() {
  try {
    const res = await fetch(UNRESOLVED_URL, { headers: { "user-agent": "fable5-watcher" } });
    if (!res.ok) {
      console.log(`[check] status.claude.com -> HTTP ${res.status} -> unknown`);
      return { state: "unknown", incident: null };
    }
    const data = await res.json();
    const hit = (data.incidents || []).find((i) => {
      const text = (i.name || "") + " " + (i.incident_updates || []).map((u) => u.body || "").join(" ");
      return i.status !== "resolved" && MATCH.test(text);
    });
    if (hit) {
      console.log(`[check] aktywny incydent Fable 5 (status=${hit.status}) -> down`);
      return { state: "down", incident: { name: hit.name, startedAt: hit.started_at, url: hit.shortlink } };
    }
    console.log("[check] brak incydentu Fable 5 -> up");
    return { state: "up", incident: null };
  } catch (err) {
    console.log(`[check] błąd: ${err} -> unknown`);
    return { state: "unknown", incident: null };
  }
}

// ── Logika watchera (maszyna stanów + heartbeat) ─────────────────────────────
export async function tick(env) {
  const { state, incident } = await checkStatus();

  // Nie znamy stanu (np. strona statusu nieosiągalna) — nic nie zmieniamy i nie powiadamiamy.
  if (state === "unknown") return;

  const kv = env.FABLE_STATE;
  const now = Date.now();
  const prev = (await kv.get("status")) || "";                       // '', 'up', 'down'
  let upStreak = parseInt((await kv.get("upStreak")) || "0", 10);
  let lastDownPing = parseInt((await kv.get("lastDownPing")) || "0", 10);

  // Anty-miganie: powrót ogłaszamy dopiero po N kolejnych odczytach "up".
  upStreak = state === "up" ? upStreak + 1 : 0;
  await kv.put("upStreak", String(upStreak));

  // Stan docelowy: 'up' dopiero po potwierdzeniu; 'down' natychmiast; inaczej brak zmiany.
  let desired = null;
  if (state === "up" && upStreak >= CONFIRM_UP_CHECKS) desired = "up";
  else if (state === "down") desired = "down";
  if (desired === null) return; // "up" jeszcze niepotwierdzony — czekamy na kolejny odczyt

  if (desired !== prev) {
    // ── ZMIANA STANU ──
    if (desired === "up") {
      await notify(env, `<@${env.DISCORD_USER_ID}> 🎉 **Fable 5 jest znowu dostępny!** Incydent na status.claude.com rozwiązany. Sprawdź Claude Code / claude.ai.`, true);
    } else {
      // desired === 'down'
      if (prev === "up") {
        await notify(env, `<@${env.DISCORD_USER_ID}> ⚠️ **Fable 5 znów niedostępny**${incident ? ` — ${incident.name}` : ""}. Monitoruję dalej i dam znać, gdy wróci.`, true);
      } else {
        // pierwszy start watchera
        await notify(env, `<@${env.DISCORD_USER_ID}> ✅ Watcher uzbrojony. **Fable 5 obecnie: NIEDOSTĘPNY**${incident ? ` (${incident.name})` : ""}. Powiadomię, gdy wróci. Status „wciąż niedostępny" co ${HEARTBEAT_HOURS} h.${incident && incident.url ? `\n${incident.url}` : ""}`, true);
      }
      lastDownPing = now;
      await kv.put("lastDownPing", String(now));
    }
    await kv.put("status", desired);
    return;
  }

  // ── BEZ ZMIANY STANU ──
  if (desired === "down" && now - lastDownPing >= HEARTBEAT_MS) {
    const since = incident && incident.startedAt ? ` (od ${incident.startedAt.slice(0, 10)})` : "";
    await notify(env, `⏳ **Fable 5** wciąż niedostępny${since}. Monitoruję co 60 s; kolejny status za ${HEARTBEAT_HOURS} h.`, HEARTBEAT_PINGS_YOU);
    await kv.put("lastDownPing", String(now));
  }
  // desired === 'up' i bez zmiany => cisza (żadnego spamu)
}

// ── Discord ──────────────────────────────────────────────────────────────────
async function notify(env, content, mention) {
  if (!env.DISCORD_WEBHOOK_URL) {
    console.log("[notify] brak DISCORD_WEBHOOK_URL — pomijam");
    return;
  }
  const res = await fetch(env.DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content,
      allowed_mentions: mention && env.DISCORD_USER_ID
        ? { parse: [], users: [env.DISCORD_USER_ID] }
        : { parse: [] },
    }),
  });
  if (!res.ok) console.log(`[notify] Discord HTTP ${res.status}: ${await res.text()}`);
}

function json(obj) {
  return new Response(JSON.stringify(obj, null, 2), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
