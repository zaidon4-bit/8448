# CodeCraft Studio — Render Deployment Guide

This release uses English-only website UI and manual membership approval. No payment gateway or external connector integration is required.

## 1. Upload to GitHub

Push the contents of this directory to the repository root, keeping `render.yaml` at the root. Never commit a real `.env` file, provider credentials, or administrator passwords.

## 2. Create the Render service

1. Open Render and choose **New → Blueprint**.
2. Connect the GitHub repository and review the Blueprint.
3. The service uses Docker, the Starter plan, and a 2 GB persistent disk mounted at `/var/data`. Check Render's current price before deploying.
4. After the deploy succeeds, open the public service URL shown by Render.

## 3. Environment variables

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

## 4. Manual membership approval

1. A user registers and requests membership review.
2. The administrator independently verifies the payment/approval.
3. In `/admin`, select the user and set the duration (1–3650 days; default 30).
4. Choose **Verify payment and activate**. Access becomes active immediately and expires automatically.
5. Use **Deactivate membership** to revoke access immediately.

No Stripe secrets or Stripe webhook are needed for this manual mode.

## 5. Deployment smoke tests

1. Visit `/healthz` and confirm `ok: true`.
2. Register a normal user and confirm workspace access is blocked before membership approval.
3. Configure a valid API connection, then manually activate the test account.
4. Send a short coding task asking OpenCode to create a file and run a harmless test. Check the response, provider-reported token data, and Render logs.
5. Test web search separately. Exa access is enabled for the worker; actual search capability can still depend on current service availability.
6. Revoke membership and confirm that the workspace is inaccessible.

## Security notes

- Keep `APP_ENCRYPTION_KEY` stable and private.
- The app is designed for one Render instance with a persistent disk and SQLite.
- Private workspaces and Unix identities are not full containers. Add per-task isolation and resource/network limits before opening arbitrary command execution to the public.
- Timing is measured by the application. Token usage is provider-reported; if the provider omits usage, the UI says it is unavailable rather than showing a fabricated number.

## Admin performance and prompt controls

In `/admin`, use **Assistant behavior** to set reasoning effort (`Low`, `Medium`, or `High`) and edit the global System Prompt. `Low` is the default for faster replies; on Gemini 2.5 Pro over Google's OpenAI-compatible schema this maps to the low thinking budget (about 1,024 thinking tokens), while `Medium` and `High` spend more reasoning. This setting only works if the selected upstream gateway accepts and forwards `reasoning_effort`. Gemini 2.5 Pro thinking cannot be disabled entirely.

When an active subscriber opens the workspace, the app starts OpenCode in the background to reduce worker startup delay on the first message. The initial `7,596 input tokens` shown in the earlier screenshot are input/context tokens (including the agent instructions and native tool definitions), not the number of reasoning tokens. The ~54-second response time likely included lazy worker startup and the upstream model's default thinking behavior; after deploying this change, compare a new simple greeting and inspect the reported duration.


## Subscriber reasoning controls

Each subscribed user can choose Low, Medium, High, or XHigh from the chat composer. The setting is saved to that user’s account and is applied by the server-side provider proxy. The official Gemini 2.5 Pro OpenAI-compatible mapping documents Low, Medium, and High; XHigh is accepted by the application UI but maps to High for this model/API route, so it is not a distinct fourth Gemini 2.5 Pro effort level. Other providers may support different effort variants.


## إعدادات التفكير والمهارات الشخصية

بعد تسجيل الدخول وفتح مساحة العمل، يستطيع كل مستخدم اختيار Automatic Thinking أو تفعيل ميزانية Thinking Budget مستقلة، واختيار Long Answer Target. الميزانية التلقائية تُرسل كـ `thinking_budget: -1` في حقل توافق Google؛ أما الميزانيات اليدوية فتُمرر عبر `extra_body.google.thinking_config.thinking_budget`. يجب اختبار دعم هذا الحقل عبر بوابة الموديل المستخدمة. طول الرد المستهدف ليس حداً أدنى مضموناً.

زر Skills يتيح إضافة مهارات OpenCode خاصة بالمستخدم عبر ملفات `SKILL.md`. المهارات محفوظة في مجلد HOME الخاص بالمستخدم ولا تُشارك بين الحسابات.
