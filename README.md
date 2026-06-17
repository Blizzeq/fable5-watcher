# fable5-watcher

Cloudflare Worker, który **co 60 sekund** sprawdza, czy model **Fable 5** jest
dostępny, i powiadamia Cię na **Discordzie**, gdy wróci. Działa w chmurze, za
darmo, bez włączonego komputera i **bez klucza API / bez kredytów**.

## Jak wykrywa dostępność (ważne)

Źródłem prawdy jest **oficjalna strona statusu Anthropic**:
`https://status.claude.com/api/v2/incidents/unresolved.json`

Fable 5 jest traktowany jako **NIEDOSTĘPNY**, dopóki istnieje nierozwiązany
incydent dotyczący „Fable 5" (obecnie: *„We've suspended access to Claude Mythos 5
and Claude Fable 5"*, dotyczy m.in. **Claude Code** i **claude.ai**). Gdy ten
incydent zostanie rozwiązany i zniknie z listy → **Fable 5 jest znowu dostępny**.

**Dlaczego nie developerskie API:**
- `GET /v1/models` listuje `claude-fable-5` nawet gdy w produkcie jest „unavailable" → **fałszywy alarm**.
- `POST /v1/messages` wymaga kredytów i dotyczy API dla deweloperów, a nie produktu (Claude Code/claude.ai).
- Strona statusu jest darmowa, bez logowania i **wprost wymienia Claude Code** jako objęty incydentem — czyli zgadza się z tym, co widzisz w aplikacji.

## Logika powiadomień (watcher)

Stan trzymany w Workers KV; sprawdzenie co 60 s. Reguły:

| Sytuacja | Co robi |
|---|---|
| **Powrót** (niedostępny → dostępny) | 🎉 ping z @oznaczeniem (push). Wymaga 2 kolejnych potwierdzeń (anty-miganie). |
| **Spadek** (dostępny → niedostępny) | ⚠️ ping z @oznaczeniem. |
| **Wciąż niedostępny** | ⏳ status co `HEARTBEAT_HOURS` (domyślnie 3 h), bez push (tylko wiadomość na kanale). |
| **Pierwszy start** | ✅ „Watcher uzbrojony — Fable 5 obecnie: …". |
| **Brak odczytu** (strona statusu nieosiągalna) | nic — nie zmienia stanu, nie powiadamia. |
| **Wciąż dostępny** | cisza (zero spamu). |

Ustawienia na górze [`src/index.js`](src/index.js): `HEARTBEAT_HOURS`,
`HEARTBEAT_PINGS_YOU` (czy heartbeat ma robić push), `CONFIRM_UP_CHECKS`.

**Koszt: 0 zł** — strona statusu jest darmowa; 1440 wywołań/dobę << darmowy limit Cloudflare (100k/dobę).

## Konfiguracja i deploy

```bash
npm install
npx wrangler kv namespace create FABLE_STATE   # wklej `id` do wrangler.toml
# wstaw swoje Discord User ID do wrangler.toml ([vars].DISCORD_USER_ID)
npx wrangler secret put DISCORD_WEBHOOK_URL      # wklej URL webhooka Discord
npx wrangler deploy
```

> Klucz `ANTHROPIC_API_KEY` **nie jest już potrzebny** (metoda nie używa API). Jeśli wcześniej go ustawiłeś: `npx wrangler secret delete ANTHROPIC_API_KEY`.

## Test / weryfikacja

```bash
# Lokalny test detekcji na żywej stronie statusu:
node --input-type=module -e "import('./src/index.js').then(m=>m.checkStatus()).then(console.log)"

# Testowy ping na Discord (lokalnie, po uzupełnieniu .dev.vars):
npx wrangler dev
#   -> otwórz http://localhost:8787/?test=ping

# Aktualny stan w KV (produkcja):
npx wrangler kv key get "status" --binding=FABLE_STATE --remote   # 'down' | 'up'

# Logi na żywo (każde uruchomienie co 60 s):
npx wrangler tail
```

## Zarządzanie

```bash
npx wrangler deploy        # po zmianie ustawień
npx wrangler delete        # całkowicie usuń watcher
# zmiana częstotliwości: pole `crons` w wrangler.toml (min. granulacja Cloudflare: 1 min)
```

## Pliki

| Plik | Rola |
|------|------|
| `src/index.js` | Worker: detekcja (status.claude.com) + maszyna stanów + Discord |
| `wrangler.toml` | konfiguracja: cron `* * * * *`, KV, `DISCORD_USER_ID` |
| `.dev.vars.example` | szablon lokalnych sekretów (skopiuj do `.dev.vars`) |
| `package.json` | skrypty + `wrangler` |
