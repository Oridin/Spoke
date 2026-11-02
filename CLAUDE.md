# Spoke

Custom home screen launcher for rooted LG webOS TVs.

## Tech Stack

- **Preact + TypeScript + Vite** — IIFE bundle
- **Target:** Chrome 53 (webOS 3.x) and Chrome 79 (webOS 5+)
- Two builds: `app.js` (esbuild, chrome53 syntax) and `app.legacy.js` (Babel ES5 + core-js-bundle polyfills)
- No flex gap, no `inset`, no `aspect-ratio`, no `String.padStart` in the main build — Chrome 53 lacks them

## Build & Deploy

```bash
npm run build          # tsc --noEmit && vite build && legacy build
npm run package        # builds + packages into .ipk (HBC install format)
npm run install:tv     # installs .ipk on TV via SSH (needs TV_HOST in tv.env)
```

### Soft deploy (SCP, faster iteration)

Deploy both `app.js` AND `app.legacy.js` to the TV:

```bash
scp -i ~/.ssh/lgtv_lounge dist/assets/app.js dist/assets/app.legacy.js root@192.168.71.174:/media/developer/apps/usr/palm/applications/com.oridin.spoke/assets/
```

Always send a toast after SCP deploy:

```bash
ssh -i ~/.ssh/lgtv_lounge root@192.168.71.174 "luna-send -n 1 -f luna://com.webos.notification/createToast '{\"message\":\"Spoke updated\"}'"
```

### TVs

- **Lounge:** `ssh -i ~/.ssh/lgtv_lounge root@192.168.71.174`
- **Basement left:** `ssh -i ~/.ssh/lgtv_bedroom root@192.168.71.219`
- Don't deploy to basement TV unless user says so.

## Architecture

### Screens

- `Home.tsx` — App bar (tiles) + Cinema panel above it. Focus starts on the first app tile; press Up to reach Cinema.
- `Cinema.tsx` — Tabbed panel (Home/Browse/My Server/Watchlist/Downloads). Starts in `rows` zone (sidebar collapsed).
- `Browse.tsx` — TMDB discover/search. Opens action panels via `onOpenPanel` callback to Cinema.
- `MyServer.tsx` — Plex library browser. Detail panel: Play on Plex / Add to Watchlist / Download / Seasons.
- `Watchlist.tsx` — Monitored titles from Sonarr/Radarr. Detail panel: Search Now / Download / Stop Monitoring.
- `Downloads.tsx` — Active queue and history from Sonarr/Radarr.

### Key Libraries

- `lib/plex.ts` — Plex API (XHR with apiCall fallback). PlexIndex: TMDB-id lookup for "Play on Plex" in Cinema panels.
- `lib/arrapi.ts` — Sonarr v3 + Radarr v3 API. Download scope selection (episode/season/latest/all). Uses `apiCall()` with shell `exec`+curl; body via temp file (`curl -d @file` + `shellQuote()`).
- `lib/tmdb.ts` — TMDB API for discover, search, watch providers.
- `lib/trending.ts` — Trending data types, provider definitions, cache.
- `lib/pin.ts` — PIN lock for hidden Plex library sections.
- `lib/launch.ts` — `launchApp()` via webOS Luna service.

### Navigation

- `useKeys` for regular D-pad navigation
- `useKeyTrap` (capture-phase) for modal overlays (confirm dialogs, dl-scope panels)
- `useOkPress` for enter/OK button with long-press support
- Back key (keyCode 461) and Escape (27) for back navigation

### Download Flow (TV Shows)

All three screens (Cinema, MyServer, Watchlist) share the same scope picker:
1. `dl-scope`: Episode… / Season… / Latest Season / All Episodes / Cancel (Cancel focused by default)
2. `dl-seasons`: Pick a season (with episode counts)
3. `dl-episodes`: Pick an episode (S01E01 format)
4. `dl-confirm`: Shown when >30 episodes selected

### Plex Index

Lightweight in-memory TMDB-id index of the user's Plex library. Fetches all non-hidden sections with `includeGuids=1`, caches for 10 minutes, refreshes on return to Spoke. Titles on the server get "Play on Plex" as the first action button; movies on server hide Download (show "On your server" label); shows keep Download since new episodes may be missing.

## Connections

Configured in Settings → Connections. Stored in localStorage via `lib/storage.ts`.

- **Sonarr** — TV show management (add, monitor, search, queue)
- **Radarr** — Movie management (add, monitor, search, queue)
- **Plex** — Library browsing, on-deck, recently added
- **TMDB** — Trending, discover, search, watch providers
- **Fetchbox** — Seedbox integration

## Security Rules

- `apiCall()` must NEVER build shell commands by concatenating untrusted strings. Use strict argument escaping, send JSON bodies via temp file with `curl -d @file` + `shellQuote()`.
- Never show the Plex token in on-screen error messages, logs, or image URLs. `safeError()` strips it.
- The Fetchbox passcode lives in Connections settings, not in source code. Never print it in logs or chat.
- The plaintext PIN must never be written to any file (source, comments, tests, docs, config, logs, git) and must not be echoed in output.
- Hidden libraries must NEVER be indexed or matched while locked.
- Don't run any Sonarr/Radarr searches or grabs directly — only through the app's UI flow.
- Don't touch ~/torrents/data or anything on the seedbox from the TV app. Spoke only calls APIs.

## Style Rules

- Animate only `transform` and `opacity` (GPU-composited, no reflow)
- Overlays must capture keys (`useKeyTrap`)
- No delete actions shown in browse/cinema panels (only in Watchlist with `enableDeleteActions`)

## Plugins

- **Impeccable** v4.8.0 (commit `e89e3ada3e`) — design skill by Paul Bakaus. Reviewed 2026-11-01. Installed project-scoped via marketplace. For visual design work only: must never change navigation, focus logic, data, or behavior unless explicitly asked. Hooks run a design anti-pattern detector after Edit/Write on UI files; disable with `/impeccable hooks off`.
- **Ponytail** — reviewed and declined (2026-11-01). Too invasive for this project: injects rules into every prompt/subagent, optional telemetry webhook, conflicts with active feature-building workflow.
