# CodeCraft Studio — Render deployment package

CodeCraft is an Arabic browser-based coding workspace powered by the OpenCode headless server. It includes account registration/login, an admin dashboard, encrypted per-user API settings, manual subscription approval, private workspaces, project file upload/download, a persistent coding prompt, and the yellow-cube work animation.

The public UI does not reveal model-provider names, model identifiers, gateway URLs, or credentials. API settings are configured in `/admin` per account. API and MCP settings are encrypted at rest with `APP_ENCRYPTION_KEY` and never returned by admin APIs.

## Features

- `server.js`: Express app, SQLite persistence, authentication, admin routes, encrypted user API and MCP settings, manual subscription requests and approval, OpenCode process manager, private provider gateway, and upload/export endpoints.
- `opencode/system-prompt.txt`: persistent instructions for the coding agent.
- OpenCode's built-in tools are enabled; Exa web search and experimental LSP are enabled; language servers are installed for common languages. Reviewer/tester/researcher subagents and bundled skills are available. MCP servers are configured by the administrator for each user.
- `Dockerfile` installs OpenCode and checks that `opencode serve` is present during image build.
- The responsive Arabic app uses a full-screen chat and the supplied yellow-cube animation.

## Render deployment

1. Push the contents of this directory to GitHub with `render.yaml` at the repository root.
2. In Render choose **New → Blueprint**, connect the repository, review `render.yaml`, and create the service. It uses a paid Starter service and a persistent disk mounted at `/var/data`; check Render's current costs before deploying.
3. Configure `ADMIN_EMAIL` and `ADMIN_PASSWORD` in Render. The password must be unique and at least 14 bytes.
4. Render generates `SESSION_SECRET` and `APP_ENCRYPTION_KEY`; preserve both values. Changing `APP_ENCRYPTION_KEY` can make previously saved API/MCP credentials undecryptable.
5. Set `APP_URL` to the exact public origin of your deployed app, for example `https://your-service.onrender.com`.
6. Optional shared fallback AI values are `AI_BASE_URL`, `AI_MODEL_ID`, and `AI_API_KEY`. Prefer configuring a separate provider endpoint, model ID and key for each user from `/admin`.
7. Open `/healthz` to verify the service is responding, then sign in with the configured admin account and visit `/admin`.

## Manual subscription approval

Stripe is not required. A newly registered account has no active subscription. The user can press **طلب مراجعة وتفعيل الاشتراك** on the membership page; this marks a request for the administrator. After verifying payment or approval out of band, the administrator selects the user at `/admin`, enters the subscription duration in days (default 30), then presses **تأكيد الدفع وتفعيل**. Access is checked on the server and the subscription expires automatically based on its end timestamp. The **إلغاء التفعيل** action revokes access immediately. Only authenticated administrators can invoke these routes.

The subscription request is informational; it does not prove payment. The administrator must independently verify payment before activating access.

## Local development

- Install Node.js 22+, Git, Python 3 and build tools needed for `better-sqlite3`.
- Copy `.env.example` to `.env`, set private values, and never commit `.env`.
- Run `npm install`, then `npm start`.
- The Docker build installs OpenCode automatically. For local use outside Docker, install the OpenCode CLI and make `opencode` available on `PATH`.

## Operations and security

- OpenCode is managed as a headless server. Each user gets a separate Unix identity, private home/config and workspace. Provider credentials stay in the root-owned web process and the worker receives a per-user token for a loopback gateway.
- The app uses SQLite on a persistent disk and is designed for a single Render instance. Do not scale horizontally without migrating to a managed database and separate workers/queues.
- A Unix UID/workspace boundary is not a complete sandbox. For a public coding service, add per-task containers/VMs, CPU/memory/process limits, outbound network controls, usage quotas, abuse monitoring and a security review before allowing arbitrary users to execute code.
- The animation is a visual progress indicator; it does not expose private reasoning or guarantee progress.

## Admin and user-specific configuration

Set `ADMIN_EMAIL`, `ADMIN_PASSWORD`, and a stable `APP_ENCRYPTION_KEY`. Sign in and visit `/admin`. Select a user to configure an API base URL, model ID, API key, MCP JSON, account suspension, and manual subscription status. Keys are encrypted using AES-256-GCM and are never returned to the browser after saving.
