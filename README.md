# Hermes Lite WebUI

A static, mobile-first chat front-end for [Hermes Agent](https://hermes-agent.nousresearch.com/docs).
**No backend of its own, no keys on the server.** A visitor enters their own Base URL and API key;
both stay in that browser's local storage, and requests go straight from the browser to the Hermes
gateway they configured.

Conversation history is the **same one the desktop app / CLI / dashboard use** (`state.db`):
the sidebar lists real server-side sessions, opening one shows that desktop conversation, and a
turn you send here is written back into the same session.

> 中文说明见 [README.zh-CN.md](README.zh-CN.md)。

---

## Why it exists

Hermes ships a desktop app, a TUI and a messaging gateway, but nothing you can drop on a static
host and hand a URL to. This is that: one folder of HTML/CSS/JS, no build step, no dependencies,
no npm install. Deploy it anywhere that serves files.

## Features

- **Static and dependency-free** — plain ES modules, no bundler, no framework, no build.
- **Keys never leave the browser** — config lives in `localStorage`; the static files contain no
  credentials, so the host cannot impersonate anyone.
- **Shared history** — sessions, messages and tool calls come from the gateway's `state.db`, so the
  web UI and the desktop app are the same conversations. Session source badges say where each
  conversation came from (desktop / web / CLI / Telegram …).
- **Concurrent sessions** — each conversation keeps its own stream. Starting a turn in one session
  does not block switching to another, or starting a new one; switching back re-renders from the
  accumulating text. The sidebar spins for sessions that are generating.
- **Tool calls interleaved with text** — each tool chip is placed at the point in the reply where it
  actually ran, driven by a character offset recorded when the event arrived.
- **Image input** — pick a file or paste a screenshot; images are downscaled in the browser before
  being sent as `data:` URLs.
- **Stop mid-turn** — the stop button asks the gateway to stop the run, then drops the local stream,
  for that session only.
- **Markdown** — code blocks with language label and copy, tables, lists, quotes, links; escaped
  before any markup is inserted.
- **Usage page** — totals over the server's session rows (sessions, messages, tool calls,
  input/output tokens, cache reads, cost).
- **Export** — save the open conversation as Markdown.
- **Mobile-first** — drawer sidebar, safe-area insets, 100dvh, 16px inputs (no iOS zoom), visual
  viewport handling for the soft keyboard, PWA shell with an offline fallback.

## Requirements

- A running Hermes Agent whose **api_server** (the gateway) is reachable from the browser over
  HTTPS, e.g. `https://hermes.example.com/v1`.
- Its `API_SERVER_KEY`.
- Nothing else. The api_server sends `Access-Control-Allow-Origin: *`, so a purely static deployment
  works without a reverse proxy. (If you tighten CORS, deploy the files same-origin behind your proxy
  instead.)

## Quick start

1. Put the files on any static host (or serve them locally: `python -m http.server 8080`).
2. Open the page. On first visit, enter your **Base URL** and **API key**; they are stored locally.
   The "test connection" action checks both the model list and whether session history is readable —
   it catches the half-working case where you can chat but cannot see history.

You can also pre-fill the gateway URL for your users via a query parameter:

```
https://your-host/hermes/?base=https://hermes.example.com/v1
```

Visitors then only paste their own key.

## Phone notifications (ntfy)

Hermes events can land in your phone's notification shade through [ntfy](https://ntfy.sh/) — an
open-source pub-sub push service with Android/iOS apps, self-hostable.

**How this app does it: the browser sends it.** *Settings → 手机通知（ntfy）* takes a server URL, a
topic and (optionally) an access token. When a reply finishes — or a turn fails, or the session is
busy in another client — the page POSTs to `https://<server>/<topic>` and your phone shows a
notification. The site stays static: no proxy, nothing stored on the server, the topic and token
live only in your browser's localStorage (same rule as the API key). This works because ntfy answers
cross-origin preflights with `Access-Control-Allow-Origin: *`.

Setup: install the ntfy app → subscribe to a topic (pick something unguessable: anyone who knows the
topic can publish to it) → enter the same topic in Settings → hit *发送测试通知*.

Stated plainly:

- **The page has to be alive.** Close the tab and nothing is sent — a static page cannot push out of
  nowhere. For page-closed delivery, let the **Hermes host** send instead: Hermes ships an ntfy
  platform adapter, so one shell hook plus `hermes send --to ntfy` covers that half.
- Titles are Chinese, so they go out as RFC 2047 encoded words — HTTP headers cannot carry raw UTF-8,
  and ntfy decodes the encoded form.
- A topic on the public `ntfy.sh` is public. Self-host ntfy with access control and set a token in
  the settings if the content matters.

## Endpoints used

| Purpose | Endpoint |
|---|---|
| List sessions | `GET /api/sessions?limit=&offset=` |
| Create session | `POST /api/sessions` |
| Read history | `GET /api/sessions/{id}/messages?limit=&order=` |
| Send a turn | `POST /api/sessions/{id}/chat/stream` (SSE) |
| Rename / pin | `PATCH /api/sessions/{id}` |
| Delete | `DELETE /api/sessions/{id}` |
| Model probe | `GET {base}/models` |

Sending uses the session-scoped streaming endpoint because it is the only one that both **reads the
session's history from the database** and **returns CORS headers the browser can read**. See
`js/api.js` for the exact event vocabulary
(`run.started`, `assistant.delta`, `tool.started|completed|failed`, `assistant.completed`,
`run.completed|failed|cancelled`).

There is a second surface — `POST {base}/chat/completions` with an `X-Hermes-Session-Id` header —
where the server **replaces** the request body's `messages` with the session's stored history, so
you only send the new user turn. It requires API-key authentication, and the server echoes back the
session id it actually bound (the id can change after a context compression).

Sessions are named automatically by the server after the first exchange, so the sidebar fills in
titles on its own.

## Local data

`localStorage` holds exactly three keys (`hermes-lite-webui.{config,prefs,cache}.v1`): connection
config, preferences, and a read-only cache (session list plus the last few conversations, for
instant open and offline viewing). **The authoritative copy of history is server-side** — clearing
browser data never loses a conversation.

## Security notes

- `API_SERVER_KEY` is not "just an API key": the api_server dispatches terminal-capable agent work
  — the source comment is "a guessable key is remote code execution". Whoever holds it can run
  commands on the host and read every session of that profile.
- Never commit it, never bake it into the page or a build artifact. This project exists precisely so
  the key is typed by each visitor and stays in their browser.
- Serving several people? The api_server supports **profile-scoped keys** and mirrors each profile
  under `/p/<profile>/`. Give each person their own profile and base URL
  (`https://host/p/<name>/v1`), which also isolates their history — one key otherwise sees all of
  that gateway's sessions. You can additionally put basic auth on the static host.
- The session-busy case is handled: if the same conversation is already running elsewhere, the
  gateway answers with a short refusal instead of executing, and the UI says so rather than
  pretending it was a reply.

## Known limitations

- **Rename / pin / archive / mark-unread are unavailable from the web UI.** The gateway's CORS
  preflight advertises `GET, POST, DELETE, OPTIONS` only, so a cross-origin `PATCH` never leaves the
  browser. The route has no POST alias, so there is no front-end workaround.
- **Choice prompts (`clarify`) are unavailable.** The api_server surface never injects the clarify
  callback, so the tool is absent from the model's schema there. Numbered options in a reply are
  rendered as clickable chips instead.
- **Images are not persisted to history.** On the way into `state.db`, image parts are projected to
  the text placeholder `[screenshot]` (by design — it keeps megabytes of base64 out of the session
  database). A sent image is visible in the current session but not after a reload.
- **Tool emoji for past rows come from a local table** — the server only sends emoji on live events.
- **Deleting a session is cross-device**: deleting a desktop session here removes it there too.
- **UI strings are Chinese.** The code comments are Chinese too; the READMEs are bilingual.

## Updating a deployment

The service worker serves static assets **network-first** (falling back to cache when offline), and
a newly activated worker reloads the page once, so a deploy takes effect on the next load. It only
ever caches this site's shell — cross-origin requests and `/api`, `/v1` paths are never intercepted.
If you change the caching strategy, bump `VERSION` in `sw.js` so old caches are dropped.

## Layout

```
index.html              entry point (setup screen + main UI + settings drawer)
css/                    tokens, base, layout, components
js/api.js               gateway client (REST + SSE parsing)
js/store.js             localStorage: config, prefs, read-only cache
js/ui.js                rendering (sessions, replies, tool chips, options, approvals)
js/main.js              startup, state machine, per-session streams, wiring
js/markdown.js          small, escape-first markdown renderer
js/settings.js          settings drawer
sw.js, manifest...      PWA shell
```

## Development check

The front-end has no test runner; end-to-end checks drive a real Chrome over CDP
(`127.0.0.1:9222`) against a locally served copy:

```bash
python -m http.server 8915 --bind 127.0.0.1
# then a script under _tools/ (not shipped in this repository) using your own key
```

Two habits worth keeping: clear the service worker and caches before asserting on freshly changed
files, and verify the rendered block order of a reply (text / tool / text) rather than trusting a
screenshot alone.

## License

MIT — see [LICENSE](LICENSE).
