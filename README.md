# VORTEX BOT

A Node.js Messenger bot scaffold with a protected Express dashboard, command modules, AppState validation, structured logs, and Railway deployment files. Developer branding: **Zero To**.

> **Important:** Messenger automation depends on Meta/Messenger behavior and the exact installed `@dongdev/fca-unofficial` API. This project does not bypass platform restrictions. Real login has not been verified without a valid user-provided AppState and an available network connection.

## Requirements
- Node.js 22.x (the package engine permits Node 20–22)
- npm 10+
- A valid AppState supplied by the account owner

## Local setup
1. Run `npm install`.
2. Set `OWNER_ID` (or comma-separated `OWNER_IDS`) to the initial numeric Messenger Owner ID(s), up to 3, and optionally set `ADMIN_IDS` to comma-separated regular Admin IDs, up to 20. The dashboard Admins section lets the Owner add/remove IDs and saves them in `data/settings.json`. Never commit `.env` or AppState.
3. Set a strong `DASHBOARD_PASSWORD` before exposing the Dashboard publicly. You may set `ADMIN_DASHBOARD_PASSWORD` for a separate read-only admin login. A random `SESSION_SECRET` is generated and saved automatically when omitted.
4. Run `npm start`.
5. Open `http://localhost:3000/login` and submit AppState in the protected Dashboard section. It is saved in `data/appstate.json`; do not commit this file or share its contents.

## Optional environment variables
| Variable | Purpose |
|---|---|
| `DASHBOARD_PASSWORD` | Overrides the default Dashboard password `vortex110` |
| `SESSION_SECRET` | Optional session-signing secret; generated and stored locally when omitted |
| `APPSTATE_JSON` | Optional AppState JSON array; the Dashboard is recommended |
| `OWNER_ID` | Initial numeric Messenger Owner ID; overridden by saved Owner list when present |
| `OWNER_IDS` | Optional comma-separated initial Owner IDs (maximum 3) |
| `ADMIN_IDS` | Comma-separated numeric Messenger IDs for ordinary admins |
| `ADMIN_DASHBOARD_PASSWORD` | Optional separate password for read-only dashboard admin access; `DASHBOARD_PASSWORD` is the owner login |
| `BOT_NAME` | Display name; defaults to VORTEX |
| `PREFIX` | Command prefix; defaults to `*` |
| `PORT` | Web port; Railway injects this |
| `NODE_ENV` | Use `production` behind HTTPS |

Runtime data is stored in the project's `data/` directory. For persistence on Railway, attach a Volume at the app's `/app/data` directory. No environment variable is needed to set file paths.

## Commands
Commands live in `cmds/` and export `name`, `aliases`, `description`, `execute(api, event)` and optionally `adminOnly`. Prefix examples: `*ping`, `*help`, `*info`, `*uptime`, `*uid`, `*admin`, `*groups` (Arabic alias `*غروبات`), `*kick`, `*prefix`, `*reload`. The Owner can run `*غروبات` to review group chats in message requests, Other/possibly spam, and accepted Inbox. Reply with `1`, `2`, or `3` to choose a folder, then a group number, then `1` to accept/confirm or `2` to cancel. Accepting a request moves it to Inbox and sends `𝑹𝑶𝑪𝑲𝑬𝑻 🚀` to the selected group; this command is owner-only and limits the displayed list to 30 groups from the first 100 threads returned by Messenger. The owner or a configured bot admin can also reply to a message containing an image and run `*تغييرالصورة` (aliases: `*تغييرالصوره`, `*صورةالحساب`, `*صورهالحساب`) to set the account profile picture to that image. This command uses the dashboard-configured prefix, accepts supported image types up to 8 MB, and only fetches images from Facebook image hosts. Owner/admins can start a repeating message using the dashboard-configured prefix, for example `*تشغيل <النص> 25ث` or `*تشغيل <النص> 2د` when the prefix is `*`, and stop it in that conversation with `*إيقاف`. These commands follow any prefix configured in the dashboard. Repeating messages are limited to one active task per conversation, intervals from 10 seconds to 24 hours, and stop when the bot disconnects. `*admin` lets bot admins view the separate Owner and regular Admin lists; Owners can add/remove regular Admin IDs. The dashboard Admins section stores up to 3 Owners and 20 regular Admins separately in persistent settings. Owners have full bot-command privileges; regular Admins have ordinary admin privileges. Dashboard login roles remain password-based. The `uptime` command (aliases: `up`, `مدة`, `مدة_التشغيل`) shows how long the current bot process has been running. Command output uses paced sending, suppresses repeated outgoing content within a short window, and applies a local send cap. Outbound protection now opens a 15-minute circuit breaker immediately when rate-limit/restriction-like send errors are detected, stops all repeating-message tasks, and blocks outgoing sends during the pause. Three consecutive generic send failures within two minutes also open the circuit breaker. Authentication/checkpoint-like send errors pause sending until a fresh AppState is saved and stop automatic reconnect retries. The Security dashboard displays the current protection state. Duplicate delivery of the same incoming command message ID is ignored. These safeguards reduce accidental spam and runaway retries but cannot guarantee that Messenger will not restrict or block an account, and they do not bypass platform limits. The dashboard also displays live FCA/session health and shows a reauthentication warning when login/checkpoint errors are detected. In that case automatic reconnect retries pause to avoid repeatedly submitting an invalid session; save a fresh AppState from the account owner and connect again. Ordinary connection losses use delayed backoff retries. The green Facebook online indicator is controlled by Facebook and is not guaranteed by a connected bot session. The bot also attempts to enforce the group nickname `𝑽𝑶𝑹𝑻𝑬𝑿 →` when it sees group activity or nickname-change/join events; this requires the installed FCA client to support `getThreadInfo` and `changeNickname`, and it cannot guarantee enforcement if Messenger or the client rejects the request.

`kick` is intentionally capability-checked: it only calls `removeUserFromGroup` if the installed client exposes it. It does not pretend success if the method is absent. The exact `@dongdev/fca-unofficial` callback/client surface may vary by release; verify against the installed package before relying on real sessions.

## Railway
1. Create a new Railway project from this repository.
2. The Dashboard defaults to password `vortex110`; set `DASHBOARD_PASSWORD` in Railway Variables to override it before public use. `SESSION_SECRET` is generated automatically if omitted.
3. Attach a Railway Volume at `/app/data` so saved AppState, settings, and the generated session secret persist between deployments.
4. Deploy with `npm start`. `railway.json` configures `GET /health` as healthcheck.
5. Use Railway's HTTPS domain; `NODE_ENV=production` enables secure session cookies.

## Security notes
- Dashboard login is session-based, with HttpOnly/SameSite cookies, login rate limiting, and CSRF token checks on mutating API calls. The `DASHBOARD_PASSWORD` login is the owner role with full controls. If `ADMIN_DASHBOARD_PASSWORD` is configured, that separate login is read-only and cannot edit commands, credentials, settings, connections, or administrator membership.
- AppState is validated before storage and never returned by an API or written to logs. Local data should be kept on a private volume with restricted permissions.
- The owner-only AppState panel includes **Remove session**. It disconnects the bot, removes the locally saved `data/appstate.json` and AppState-refresh statistics, clears session-related runtime counters, and records a marker so the bot does not silently reload `APPSTATE_JSON` after a restart. A new AppState must be saved before reconnecting. It does not remove commands, dashboard settings, admin lists, or revoke the Facebook session on other devices.
- Dashboard command editing runs JavaScript with the bot process's privileges. Only use it with trusted administrators.
- Express's default in-memory session store is suitable for a single-process starter, not a multi-instance production deployment. Use a persistent external session store for horizontal scaling.
- Use Messenger normally, respect rate limits and account restrictions, and stop if the platform rejects access.

## Tests
Run `npm test` for Node's built-in test runner. `npm run check` runs syntax checks on project JavaScript files. Tests use mocks and do not prove real Messenger login works. Real login needs a valid AppState and a live supported FCA package/network.
