# fable5-watcher

Cloudflare Worker, który **co 60 sekund** sprawdza, czy model `claude-fable-5` jest
dostępny, i — w momencie powrotu — wysyła **ping na Discord** (push na telefon).
Działa w chmurze, za darmo, bez włączonego komputera.

## Jak to działa

```
Cron co 60 s → Worker scheduled()
   → isAvailable():
        ANTHROPIC_API_KEY ustawiony? → GET /v1/models, szukaj "claude-fable-5"
        inaczej (lub błąd)           → GET status.claude.com/api/v2/summary.json
   → porównaj z KV "available"
   → przejście niedostępny→dostępny? → POST Discord webhook (ping <@USER_ID>)
   → zapisz nowy stan do KV
```

Ping leci **tylko raz** — w momencie powrotu. Stan trzymany jest w Workers KV, więc
nie ma spamu co minutę. Jeśli model znów spadnie i wróci, dostaniesz kolejny ping.

**Koszt: 0 zł.** Cloudflare free (1440 wywołań/dobę << 100k limit), listowanie modeli
Anthropic jest darmowe, Discord webhook darmowy.

## Wymagania (jednorazowo)

1. **Cloudflare** — darmowe konto, potem `npx wrangler login`.
2. **Klucz API Anthropic** — `console.anthropic.com` → Settings → API Keys → Create Key (`sk-ant-...`).
   Samo listowanie modeli nie zużywa kredytów. (Bez klucza działa fallback na stronę statusu.)
3. **Discord webhook** — Ustawienia serwera → Integracje → Webhooki → Nowy webhook → wybierz kanał → **Kopiuj URL**.
4. **Discord User ID** — Ustawienia → Zaawansowane → włącz **Tryb dewelopera** → PPM na swoją nazwę → **Kopiuj ID**.

## Konfiguracja i deploy

```bash
npm install

# 1) Utwórz przestrzeń KV i wklej zwrócone `id` do wrangler.toml ([[kv_namespaces]].id)
npx wrangler kv namespace create FABLE_STATE

# 2) Wstaw swoje Discord User ID do wrangler.toml ([vars].DISCORD_USER_ID)

# 3) Ustaw sekrety
npx wrangler secret put ANTHROPIC_API_KEY      # wklej sk-ant-...
npx wrangler secret put DISCORD_WEBHOOK_URL     # wklej URL webhooka

# 4) Wdróż (aktywuje cron)
npx wrangler deploy
```

## Test / weryfikacja

```bash
# Testowy ping od razu (sprawdza webhook + push):
#   otwórz w przeglądarce:
#   https://fable5-watcher.<twoja-subdomena>.workers.dev/?test=ping

# Aktualny wykryty stan (JSON):
#   https://fable5-watcher.<twoja-subdomena>.workers.dev/

# Lokalnie — symulacja crona:
cp .dev.vars.example .dev.vars   # uzupełnij wartości
npx wrangler dev --test-scheduled
curl "http://localhost:8787/__scheduled"

# Wymuszenie testu przejścia (ustaw stan na "false", potem poczekaj na cron):
npx wrangler kv key put --binding=FABLE_STATE available false

# Logi na żywo (widać każde uruchomienie co 60 s):
npx wrangler tail
```

## Pliki

| Plik | Rola |
|------|------|
| `src/index.js` | logika Workera (`scheduled` + `fetch` do testów) |
| `wrangler.toml` | konfiguracja: cron, KV, `DISCORD_USER_ID` |
| `.dev.vars.example` | szablon lokalnych sekretów (skopiuj do `.dev.vars`) |
| `package.json` | skrypty + `wrangler` |
