# CodeCraft Studio — OpenCode Coding Workspace

CodeCraft is an English-language web workspace powered by the OpenCode headless server. It includes account registration/login, an admin dashboard, encrypted per-user API settings, manual membership approval, private workspaces, project upload/download, a persistent coding prompt, a compact animated thinking indicator, response timing, and provider-reported token usage.

## Features

- `server.js`: Express app, Supabase PostgreSQL persistence when `DATABASE_URL` is configured (SQLite fallback for local development), authentication, admin routes, encrypted per-user API credentials, manual subscription approval, OpenCode process manager, private provider gateway, and upload/export endpoints.
- `opencode/system-prompt.txt`: built-in default coding-agent instructions. The admin can edit the active System Prompt in `/admin`; the active value is stored on persistent disk.
- OpenCode native tools are enabled within the user's private workspace. Hosted Exa web search and experimental LSP support are enabled. The Docker image installs language servers for common languages. Reviewer/tester/researcher subagents and bundled skills are included. No custom MCP server is configured in this release.
- `Dockerfile` installs OpenCode and validates the executable and server command during image build.
- English-only responsive UI, user messages aligned right, assistant messages aligned left, transparent compact thinking cube, elapsed time shown in seconds and milliseconds, and provider-reported token usage when available. OpenCode pre-warms when a subscribed user enters the workspace to reduce first-message cold start. The default prompt asks for concise fast answers and avoids tool calls for greetings.

## Deploy to Render

1. Push this directory to GitHub with `render.yaml` at the repository root.
2. In Render, choose **New → Blueprint**, connect the repository, review `render.yaml`, then create the service. It uses Docker, a Starter service, and a persistent disk mounted at `/var/data`. Check current pricing before deploying.
3. Create a Supabase project, open **Connect**, choose the **Session pooler** for an IPv4-compatible backend, and copy the full PostgreSQL connection string.
4. In Render → Environment, set `DATABASE_URL` to that connection string. Keep it private and never commit it. The app creates its PostgreSQL tables during startup.
5. Set `ADMIN_EMAIL` and `ADMIN_PASSWORD`. Use a unique administrator password.
6. Render generates `SESSION_SECRET` and `APP_ENCRYPTION_KEY`; keep their values safe. Do not rotate `APP_ENCRYPTION_KEY` after saving encrypted user credentials unless you have a migration plan.
7. Set `APP_URL` to the exact public service origin, for example `https://your-service.onrender.com`.
8. Configure an AI connection in `/admin` for each user, or set all three shared fallback variables `AI_BASE_URL`, `AI_MODEL_ID`, and `AI_API_KEY`. If neither path is configured for the user, the assistant will return a clear configuration error.
9. Open `/healthz`. It reports `database: supabase` when `DATABASE_URL` is connected; sign in as administrator and visit `/admin`.

## Manual membership approval

Stripe is not required. New accounts are inactive. A user can request activation from the membership page. After verifying payment or authorization separately, the administrator selects that user in `/admin`, chooses a duration in days (default 30), and activates membership. Membership access is checked by the server and expires at the configured end timestamp. The administrator can revoke access immediately. A request is not proof of payment.

## Local development

- Install Node.js 22+, Git, Python 3, and build tools required by `better-sqlite3`.
- Copy `.env.example` to `.env` and choose either a private `DATABASE_URL` to Supabase or leave it unset for local SQLite development. Never commit `.env`.
- Run `npm install`, then `npm start`.
- On first startup with `DATABASE_URL`, the app creates the Supabase tables. If `/var/data/codecraft.sqlite` exists and Supabase has no users yet, it imports the existing users, chat messages, and app settings once during startup.
- The Docker build installs OpenCode. For local execution outside Docker, install the OpenCode CLI separately.

## Operations and security

- Each subscriber gets a private workspace and Unix worker identity. Provider credentials stay in the web process and are injected through a loopback proxy token.
- User accounts, subscriptions, per-user AI credentials, preferences, chat history, and app settings live in Supabase PostgreSQL when `DATABASE_URL` is set. Project workspaces, OpenCode HOME directories, uploaded files, skills, and exports still live under `DATA_DIR`, so keep the Render persistent disk mounted at `/var/data`. The app is designed for one Render instance; horizontal scaling requires shared workspace storage and a worker/queue design.
- Unix identities and directory permissions are useful boundaries but are not a complete sandbox. Before opening execution to untrusted public users, add isolated containers/VMs, CPU/memory/process limits, outbound network controls, quotas, abuse monitoring, and security review.
- The thinking animation is only a progress indicator. Response time is measured locally. Token counts are displayed only when the connected provider reports usage; CodeCraft does not invent missing token data.

## Admin API configuration

At `/admin`, select a user and enter an HTTPS API base URL, model ID, and API key. The key is encrypted with AES-256-GCM and is never returned to the browser after saving. If a default connection is configured in Render, it is used for accounts without a complete custom connection.

## Admin assistant controls

The `/admin` page lets the administrator edit the global System Prompt and manage users/API settings. Reasoning controls belong to each subscriber in the chat composer. Saving a changed System Prompt updates persistent app settings and restarts existing workers.

## Subscriber reasoning controls

Each subscribed user can choose Low, Medium, High, or XHigh and independently enable the Thinking Budget. For Gemini 2.5 Pro, these selections map to thinking budgets of 1,024, 8,192, 24,576, and 32,768 tokens respectively. `XHigh` is this application's label for Gemini 2.5 Pro's maximum manual budget, not a Google-defined reasoning-level name. With the toggle off, the proxy asks for dynamic thinking with `thinking_budget=-1`; Gemini 2.5 Pro still reasons internally. The request's HTTP success and whether ODiRouter actually applies the provider-specific field must be checked against a real upstream request.
## Authentication flow

- Account creation does not automatically sign users in. After successful registration, the UI switches to Sign In, keeps the email, clears the password field, and displays a non-error success notice.
- Sign-in is handled asynchronously without a full page reload. Users with an active membership go directly to the chat workspace; accounts awaiting manual membership approval remain on the membership screen.


## User generation preferences and personal skills

Each active subscriber can choose automatic thinking (Gemini 2.5 dynamic budget) or an explicit Thinking Budget, and a Long Answer Target (2k, 5k, 10k, or 20k tokens). Output targets guide the model and set a generation allowance; they are not a guaranteed minimum response length. Explicit Gemini thinking budgets are sent through the Google OpenAI-compatibility `extra_body.google.thinking_config.thinking_budget` field and require the configured API gateway to forward that field.

Subscribers can also add up to 20 private OpenCode Skills using a name, description, and instructions. Skills are written to each user's isolated `~/.config/opencode/skills/<skill-id>/SKILL.md`, following OpenCode's skill discovery format, and are not shared with other users.


## Generation controls and prompt enforcement

- The administrator System Prompt is loaded from persistent app settings and injected into upstream requests if it was not already included by OpenCode.
- Existing installations automatically migrate the known previous bundled default prompt to the new default, but any custom administrator prompt is preserved.
- Per-user Thinking Budget is applied to Gemini 2.5 Pro through `extra_body.google.thinking_config.thinking_budget`. Automatic mode sends `-1`; fixed mode sends the chosen budget.
- Long Answer Target is applied to the actual output-token ceiling and reinforced in system instructions for substantive tasks. It is not a guaranteed minimum response length, and simple greetings remain short.
- Render logs show a non-sensitive `Generation controls applied` diagnostic. Admin-only `/api/admin/diagnostics` reports the number/names of tool definitions sent, provider HTTP status, and the most recent OpenCode tool names actually executed; it never returns API keys or prompt contents.


### Supabase TLS troubleshooting
See `DEPLOY-AR.md` for the verified root-CA setup required when Render logs `self-signed certificate in certificate chain`. The app never disables Node TLS globally.


## Supabase TLS on Render

The app requires the Supabase root CA for verified TLS. Download the root certificate in Supabase Database Settings → SSL Configuration, then add a Render Secret File named `supabase-ca.crt`; the app reads `/etc/secrets/supabase-ca.crt` through `SUPABASE_CA_CERT_PATH`. Do not disable TLS verification globally. See `DEPLOY-AR.md` for the full steps.
