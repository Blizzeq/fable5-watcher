// Fable 5 availability watcher — Cloudflare Worker
//
// Co 60 sekund (Cron Trigger) sprawdza, czy model `claude-fable-5`
// jest znowu dostępny i — w momencie powrotu — wysyła ping na Discord.
//
// Metody detekcji:
//   1) Anthropic Models API  (gdy ustawiony ANTHROPIC_API_KEY) — darmowe, dokładne
//   2) Publiczna strona statusu status.claude.com (fallback bez klucza) — best-effort
//
// Stan trzymany w KV (binding FABLE_STATE), żeby pingować tylko przy zmianie.

const MODEL_ID = "claude-fable-5";
const STATUS_SUMMARY_URL = "https://status.claude.com/api/v2/summary.json";

export default {
  // Wywoływane przez Cron Trigger co 60 s.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkAndNotify(env));
  },

  // Endpoint pomocniczy do ręcznych testów:
  //   /?test=ping  -> wysyła testowe powiadomienie (z @oznaczeniem) na Discord
  //   /            -> zwraca aktualnie wykryty stan dostępności
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.searchParams.get("test") === "ping") {
      await notifyDiscord(
        env,
        `<@${env.DISCORD_USER_ID}> 🔔 Test: webhook działa — tak będzie wyglądać powiadomienie o powrocie Fable 5.`
      );
      return json({ ok: true, action: "test-ping-sent" });
    }

    const available = await isAvailable(env);
    const prev = await env.FABLE_STATE.get("available");
    return json({
      model: MODEL_ID,
      available,
      lastKnownState: prev,
      method: env.ANTHROPIC_API_KEY ? "anthropic-api" : "status-page",
    });
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Detekcja dostępności
// ─────────────────────────────────────────────────────────────────────────────

export async function isAvailable(env) {
  // 1) Metoda główna — Anthropic /v1/models (darmowa, nie zużywa kredytów)
  if (env.ANTHROPIC_API_KEY) {
    try {
      const res = await fetch("https://api.anthropic.com/v1/models?limit=1000", {
        headers: {
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
      });
      if (res.ok) {
        const data = await res.json();
        const found = (data.data || []).some(
          (m) => m.id === MODEL_ID || (typeof m.id === "string" && m.id.startsWith(MODEL_ID))
        );
        console.log(`[check] anthropic-api → available=${found}`);
        return found;
      }
      console.log(`[check] anthropic-api zwrócił ${res.status} — przechodzę na fallback`);
    } catch (err) {
      console.log(`[check] błąd anthropic-api: ${err} — przechodzę na fallback`);
    }
  }

  // 2) Fallback bez klucza — publiczna strona statusu (Atlassian Statuspage v2)
  try {
    const res = await fetch(STATUS_SUMMARY_URL, {
      headers: { "user-agent": "fable5-watcher" },
    });
    if (!res.ok) {
      console.log(`[check] status-page zwrócił ${res.status} — zakładam niedostępny`);
      return false;
    }
    const data = await res.json();
    const matchesFable = (s) => /fable\s*5/i.test(s || "");

    // Jeśli istnieje komponent dla Fable 5 — bazuj na jego statusie.
    const component = (data.components || []).find((c) => matchesFable(c.name));
    if (component) {
      const ok = component.status === "operational";
      console.log(`[check] status-page komponent "${component.name}" status=${component.status} → available=${ok}`);
      return ok;
    }

    // Inaczej: dostępny, jeśli nie ma nierozwiązanego incydentu o Fable 5.
    const text = (i) =>
      (i.name || "") + " " + (i.incident_updates || []).map((u) => u.body || "").join(" ");
    const aktywneZawieszenie = (data.incidents || []).some(
      (i) => i.status !== "resolved" && matchesFable(text(i))
    );
    const ok = !aktywneZawieszenie;
    console.log(`[check] status-page incydenty → aktywneZawieszenie=${aktywneZawieszenie} → available=${ok}`);
    return ok;
  } catch (err) {
    console.log(`[check] błąd status-page: ${err} — zakładam niedostępny`);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Logika powiadomień (anty-spam przez KV)
// ─────────────────────────────────────────────────────────────────────────────

export async function checkAndNotify(env) {
  const available = await isAvailable(env);
  const prev = await env.FABLE_STATE.get("available");

  // Ping tylko w momencie powrotu: dostępny teraz, a wcześniej nie był.
  if (available && prev !== "true") {
    console.log("[notify] przejście niedostępny→dostępny — wysyłam ping");
    await notifyDiscord(
      env,
      `<@${env.DISCORD_USER_ID}> 🎉 **Fable 5** (\`${MODEL_ID}\`) jest znowu dostępny!`
    );
  }

  await env.FABLE_STATE.put("available", available ? "true" : "false");
}

export async function notifyDiscord(env, content) {
  if (!env.DISCORD_WEBHOOK_URL) {
    console.log("[notify] brak DISCORD_WEBHOOK_URL — pomijam");
    return;
  }
  const res = await fetch(env.DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content,
      allowed_mentions: { parse: [], users: env.DISCORD_USER_ID ? [env.DISCORD_USER_ID] : [] },
    }),
  });
  if (!res.ok) {
    console.log(`[notify] Discord webhook zwrócił ${res.status}: ${await res.text()}`);
  }
}

function json(obj) {
  return new Response(JSON.stringify(obj, null, 2), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
