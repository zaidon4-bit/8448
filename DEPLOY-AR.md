# CodeCraft Studio — Render Deployment Guide

This release uses English-only website UI and manual membership approval. No payment gateway or external connector integration is required.

## 1. Upload to GitHub

Push the contents of this directory to the repository root, keeping `render.yaml` at the root. Never commit a real `.env` file, provider credentials, or administrator passwords.

## 2. Create the Render service

1. Open Render and choose **New → Blueprint**.
2. Connect the GitHub repository and review the Blueprint.
3. The service uses Docker, the Starter plan, and a 2 GB persistent disk mounted at `/var/data`. Check Render's current price before deploying.
4. After the deploy succeeds, open the public service URL shown by Render.

## 3. Supabase database setup

1. Create a project in Supabase.
2. Open **Connect** in the Supabase Dashboard and copy the PostgreSQL connection string for **Session pooler** (recommended for IPv4-compatible hosted backends). Use the exact host, username, and port shown there; do not invent the pooler host. If the database password contains special characters, URL-encode them in the connection string.
3. In Render → your service → **Environment**, add `DATABASE_URL` and paste the full connection string. Keep it secret. The app creates its tables at startup.
4. On first connection, if the existing Render disk has `codecraft.sqlite` and the Supabase database has no users yet, the app imports existing user accounts, chat history, saved settings, subscription data, encrypted API credentials, and prompt settings automatically. Keep `APP_ENCRYPTION_KEY` exactly the same to preserve access to the encrypted API keys. If Supabase already contains users, automatic migration is skipped to prevent overwriting records.
5. The app keeps uploaded projects, OpenCode user homes, skills, and workspaces on the Render persistent disk mounted at `/var/data`; Supabase does not replace that file storage.
6. Visit `/healthz`; when connected it returns `database: \"supabase\"`. If it reports `sqlite`, `DATABASE_URL` is not configured.

## 4. Environment variables

Required:

- `NODE_ENV=production`
- `DATA_DIR=/var/data`
- `SESSION_SECRET`: a strong, random secret of at least 32 characters.
- `APP_ENCRYPTION_KEY`: a separate stable random secret. Keep it safe; changing it can make stored API keys unreadable.
- `ADMIN_EMAIL`: administrator login email.
- `ADMIN_PASSWORD`: unique administrator password, at least 14 bytes.
- `APP_URL`: exact public Render origin.

AI connection: choose one route.

- Shared default: set `AI_BASE_URL`, `AI_MODEL_ID`, and `AI_API_KEY` together in Render.
- Per-user credentials: sign in as admin and configure the endpoint, model ID, and key for each account at `/admin`.

If neither route fully configures a user's connection, their chat will report that the AI connection is not configured. Removing connector integrations does not remove the need for a valid model API connection.

Optional defaults in the Blueprint are `MAX_ACTIVE_OPENCODE_INSTANCES=2`, `AI_REQUESTS_PER_MINUTE=15`, and `SUBSCRIPTION_DISPLAY_PRICE=Manual activation after administrator review`.

## 5. Manual membership approval

1. A user registers and requests membership review.
2. The administrator independently verifies the payment/approval.
3. In `/admin`, select the user and set the duration (1–3650 days; default 30).
4. Choose **Verify payment and activate**. Access becomes active immediately and expires automatically.
5. Use **Deactivate membership** to revoke access immediately.

No Stripe secrets or Stripe webhook are needed for this manual mode.

## 6. Deployment smoke tests

1. Visit `/healthz` and confirm `ok: true`.
2. Register a normal user and confirm workspace access is blocked before membership approval.
3. Configure a valid API connection, then manually activate the test account.
4. Send a short coding task asking OpenCode to create a file and run a harmless test. Check the response, provider-reported token data, and Render logs.
5. Test web search separately. Exa access is enabled for the worker; actual search capability can still depend on current service availability.
6. Revoke membership and confirm that the workspace is inaccessible.

## 7. Security notes

- Keep `APP_ENCRYPTION_KEY` stable and private.
- When `DATABASE_URL` is set, relational data is stored in Supabase PostgreSQL. Keep the Render persistent disk for per-user workspaces, OpenCode HOME directories, skills, and uploaded files. The app is designed for one Render instance.
- Private workspaces and Unix identities are not full containers. Add per-task isolation and resource/network limits before opening arbitrary command execution to the public.
- Timing is measured by the application. Token usage is provider-reported; if the provider omits usage, the UI says it is unavailable rather than showing a fabricated number.

## Admin performance and prompt controls

In `/admin`, the administrator edits the global System Prompt and manages users. Reasoning-level selection is not an admin control: each subscriber chooses their own level (`Low`, `Medium`, `High`, or `XHigh`) and toggles the Thinking Budget in the chat UI. For Gemini 2.5 Pro, these app levels are mapped to Google thinking budgets; `XHigh` maps to the model maximum and is an app-specific label, not a separate provider level. Gemini 2.5 Pro cannot be made to perform zero internal reasoning.

When an active subscriber opens the workspace, the app starts OpenCode in the background to reduce worker startup delay on the first message. The initial `7,596 input tokens` shown in the earlier screenshot are input/context tokens (including the agent instructions and native tool definitions), not the number of reasoning tokens. The ~54-second response time likely included lazy worker startup and the upstream model's default thinking behavior; after deploying this change, compare a new simple greeting and inspect the reported duration.


## Subscriber reasoning controls

Each subscribed user can choose Low, Medium, High, or XHigh from the chat composer. The setting is saved to that user’s account and is applied by the server-side provider proxy. The official Gemini 2.5 Pro OpenAI-compatible mapping documents Low, Medium, and High; this application additionally exposes XHigh as the model maximum fixed budget (32,768 tokens). XHigh is an application-defined budget preset, not a separate Google reasoning-level name. Other providers may support different effort variants.


## إعدادات التفكير والمهارات الشخصية

بعد تسجيل الدخول وفتح مساحة العمل، يستطيع كل مستخدم اختيار Automatic Thinking أو تفعيل ميزانية Thinking Budget مستقلة، واختيار Long Answer Target. الميزانية التلقائية تُرسل كـ `thinking_budget: -1` في حقل توافق Google؛ أما الميزانيات اليدوية فتُمرر عبر `extra_body.google.thinking_config.thinking_budget`. يجب اختبار دعم هذا الحقل عبر بوابة الموديل المستخدمة. طول الرد المستهدف ليس حداً أدنى مضموناً.

زر Skills يتيح إضافة مهارات OpenCode خاصة بالمستخدم عبر ملفات `SKILL.md`. المهارات محفوظة في مجلد HOME الخاص بالمستخدم ولا تُشارك بين الحسابات.

## Troubleshooting: System Prompt and generation controls

The current backend applies the saved administrator System Prompt to each upstream chat-completion request if OpenCode did not already include that exact prompt. It also applies the user's selected Thinking Budget and Long Answer Target in the internal provider proxy. Render logs include a non-sensitive `Generation controls applied` record with the detected model family, thinking mode/budget, output target, token ceiling, and whether the admin prompt was already present or injected. The log never includes prompt text or API credentials.

For Gemini 2.5 Pro, the proxy sends `extra_body.google.thinking_config.thinking_budget`: `-1` for dynamic mode or the selected fixed budget. It reserves output-token headroom for thinking tokens because Gemini counts thought tokens toward the total output limit. This proves the application sent the selected values, but only a real request to the configured OdiRouter model can prove that the gateway accepted and applied them.

Long Answer Target is a strong prompt preference and output ceiling, not a guaranteed minimum output count. Greetings/simple questions are intentionally kept short. For substantive coding work, the updated prompt asks the agent not to return a terse summary and to include useful implementation, files changed, and tests/results.


## Fix for `self-signed certificate in certificate chain` (Supabase)

The app verifies the Supabase Postgres server certificate. A Render deploy will fail at startup until the configured root CA file exists. Do not set `NODE_TLS_REJECT_UNAUTHORIZED=0`. This exact error indicates that Node did not trust the certificate chain presented by the configured PostgreSQL endpoint. The file may be stale, wrong, or from a different database project; replacing application code alone cannot fix a mismatched trust anchor. The secure fix is to install the root CA for the actual Supabase project:

1. In Supabase Dashboard, open **Database Settings → SSL Configuration** and download the database root certificate.
2. In Render, open **Environment → Secret Files → Add Secret File**. Use filename `supabase-ca.crt` and paste the downloaded PEM certificate contents. Render exposes it inside Docker at `/etc/secrets/supabase-ca.crt`.
3. `render.yaml` sets `SUPABASE_CA_CERT_PATH=/etc/secrets/supabase-ca.crt`. Save changes and redeploy.
4. Keep the `DATABASE_URL` secret private. The app removes URL SSL query parameters before using its verified CA configuration, so the driver does not override the CA object. Confirm that `DATABASE_URL` came from the same Supabase project and uses its Session pooler/host. After deploying the diagnostic patch, the startup log also prints the database host, TLS mode, error code, and shortened stack trace; never paste the full connection URL into a public issue.

The app also offers an explicit fallback for Supabase only: set `SUPABASE_TLS_MODE=compat`. This keeps TLS encryption but skips server-certificate verification, so it is less secure and should only be used temporarily if you accept that trade-off. Never set the process-wide `NODE_TLS_REJECT_UNAUTHORIZED=0`.

## Tool and MCP availability

The current worker configuration allows OpenCode's built-in tools inside each user's private workspace, enables hosted Exa web search through `OPENCODE_ENABLE_EXA=1`, and enables experimental LSP tools. Reviewer/tester/researcher subagents and bundled/personal skills are configured. This release does **not** configure any additional custom MCP server; MCP servers have to be added explicitly to the worker's OpenCode config, along with any required credentials and permission rules.

## Reasoning levels and skills

The chat offers Low, Medium, High, and XHigh, plus an independent **Enable Thinking Budget** toggle. For Gemini 2.5 Pro, the app maps these labels to Google documented budgets: Low=1,024, Medium=8,192, High=24,576, and XHigh=32,768 (maximum). XHigh is an app label rather than a Google-named level. When the toggle is off, the app requests dynamic reasoning with `thinking_budget=-1`; Gemini 2.5 Pro still uses internal reasoning, so this toggle does not truly disable the model's reasoning. Actual provider acceptance must be checked in Render logs.

The admin-managed System Prompt is stored in the database and synchronized to `/var/data/admin-system-prompt.txt`; it is also enforced server-side in each outgoing model request. Built-in and personal skills use OpenCode's supported `~/.config/opencode/skills/<skill>/SKILL.md` layout. The OpenCode CLI is installed and validated during Docker image build.

Admin-only live diagnostics are available at `/api/admin/diagnostics` after login. They report the OpenCode CLI version, bundled skills, active workers, database TLS mode/host, whether the database is reachable, the last request's tool definitions and upstream HTTP status, plus the latest task's actual OpenCode tool names. No API keys or prompt contents are returned. A tool-definition count greater than zero proves the schemas reached the provider gateway; `lastOpenCodeTaskDiagnostic.toolsUsed` is the end-to-end evidence that OpenCode actually executed tools. An upstream 2xx response confirms HTTP acceptance, but provider logs/behavior are still needed to prove that a gateway applied a thinking-budget extension.
