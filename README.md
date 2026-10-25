# CodeCraft Studio — OpenCode Coding Workspace

CodeCraft is an English-language web workspace powered by the OpenCode headless server. It includes account registration/login, an admin dashboard, encrypted per-user API settings, manual membership approval, private workspaces, project upload/download, a persistent coding prompt, a compact animated thinking indicator, response timing, and provider-reported token usage.

## Features

- `server.js`: Express app, SQLite persistence, authentication, admin routes, encrypted per-user API credentials, manual subscription requests and approval, OpenCode process manager, private provider gateway, and upload/export endpoints.
- `opencode/system-prompt.txt`: built-in default coding-agent instructions. The admin can edit the active System Prompt in `/admin`; the active value is stored on persistent disk.
- OpenCode native tools are enabled within the user's private workspace. Hosted Exa web search and experimental LSP support are enabled. The Docker image installs language servers for common languages. Reviewer/tester/researcher subagents and bundled skills are included.
- `Dockerfile` installs OpenCode and validates the executable and server command during image build.
- English-only responsive UI, user messages aligned right, assistant messages aligned left, transparent compact thinking cube, elapsed time shown in seconds and milliseconds, and provider-reported token usage when available. OpenCode pre-warms when a subscribed user enters the workspace to reduce first-message cold start. The default prompt asks for concise fast answers and avoids tool calls for greetings.

## Deploy to Render

1. Push this directory to GitHub with `render.yaml` at the repository root.
2. In Render, choose **New → Blueprint**, connect the repository, review `render.yaml`, then create the service. It uses Docker, a Starter service, and a persistent disk mounted at `/var/data`. Check current pricing before deploying.
3. Set `ADMIN_EMAIL` and `ADMIN_PASSWORD`. Use a unique administrator password.
4. Render generates `SESSION_SECRET` and `APP_ENCRYPTION_KEY`; keep their values safe. Do not rotate `APP_ENCRYPTION_KEY` after saving encrypted user credentials unless you have a migration plan.
5. Set `APP_URL` to the exact public service origin, for example `https://your-service.onrender.com`.
6. Configure an AI connection in `/admin` for each user, or set all three shared fallback variables `AI_BASE_URL`, `AI_MODEL_ID`, and `AI_API_KEY`. If neither path is configured for the user, the assistant will return a clear configuration error.
7. Open `/healthz`, sign in as the administrator, then visit `/admin`.

## Manual membership approval

Stripe is not required. New accounts are inactive. A user can request activation from the membership page. After verifying payment or authorization separately, the administrator selects that user in `/admin`, chooses a duration in days (default 30), and activates membership. Membership access is checked by the server and expires at the configured end timestamp. The administrator can revoke access immediately. A request is not proof of payment.

## Local development

- Install Node.js 22+, Git, Python 3, and build tools required by `better-sqlite3`.
- Copy `.env.example` to `.env`, fill in private values, and never commit `.env`.
- Run `npm install`, then `npm start`.
- The Docker build installs OpenCode. For local execution outside Docker, install the OpenCode CLI separately.

## Operations and security

- Each subscriber gets a private workspace and Unix worker identity. Provider credentials stay in the web process and are injected through a loopback proxy token.
- SQLite is stored on a persistent disk; the blueprint is designed for one Render instance. Do not scale horizontally without a managed database and worker/queue design.
- Unix identities and directory permissions are useful boundaries but are not a complete sandbox. Before opening execution to untrusted public users, add isolated containers/VMs, CPU/memory/process limits, outbound network controls, quotas, abuse monitoring, and security review.
- The thinking animation is only a progress indicator. Response time is measured locally. Token counts are displayed only when the connected provider reports usage; CodeCraft does not invent missing token data.

## Admin API configuration

At `/admin`, select a user and enter an HTTPS API base URL, model ID, and API key. The key is encrypted with AES-256-GCM and is never returned to the browser after saving. If a default connection is configured in Render, it is used for accounts without a complete custom connection.

## Admin assistant controls

The `/admin` page includes a global reasoning-effort selector (`low`, `medium`, `high`) and a System Prompt editor. The default is `low` to reduce latency. For a model ID matching Gemini 2.5 Pro, the gateway passes `reasoning_effort` through the OpenAI-compatible request; upstream provider support/pass-through must be verified with a real request. The model's reasoning cannot be disabled entirely. Saving a changed System Prompt writes it to `/var/data/admin-system-prompt.txt` and restarts existing workers.


## Subscriber reasoning controls

Each subscribed user can choose Low, Medium, High, or XHigh from the chat composer. The setting is saved to that user’s account and is applied by the server-side provider proxy. The official Gemini 2.5 Pro OpenAI-compatible mapping documents Low, Medium, and High; XHigh is accepted by the application UI but maps to High for this model/API route, so it is not a distinct fourth Gemini 2.5 Pro effort level. Other providers may support different effort variants.
## Authentication flow

- Account creation does not automatically sign users in. After successful registration, the UI switches to Sign In, keeps the email, clears the password field, and displays a non-error success notice.
- Sign-in is handled asynchronously without a full page reload. Users with an active membership go directly to the chat workspace; accounts awaiting manual membership approval remain on the membership screen.
