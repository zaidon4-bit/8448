# Thinking-level verification

CodeCraft records the requested thinking level and any provider-reported thinking-token count for each model response. It does not request or display private thought content.

## ODiRouter Gemini 2.5 Pro budget preset

When the assigned Base URL is on `odirouter.ai` and the model ID identifies Gemini 2.5 Pro, the app sends the Google thinking-budget field through the OpenAI-compatible request's `extra_body`:

| UI choice | Requested thinking budget |
| --- | ---: |
| Low | 1,024 |
| Medium | 8,192 |
| High | 24,576 |
| X High | 32,768 |
| Deep response mode | 10,000 |

The model supports budgets from 128 to 32,768; these are requested budget ceilings/soft limits, not promised actual consumption. X High is an app label for the model's maximum budget, not a separate model capability. Google documents the OpenAI-compatible mapping of `reasoning_effort` to Gemini 2.5 budgets and also documents custom Gemini thinking fields via `extra_body`.

A model-specific field saved by an administrator overrides the built-in mapping for that exact model. A generic `.env` `AI_THINKING_FIELD=reasoning_effort` does not override the special ODiRouter Gemini 2.5 Pro budget mapping.

## What the evidence badges mean

- **THINKING USAGE REPORTED**: the successful response included a positive reported thinking-token count in a recognized usage field. This is evidence that the provider reported thinking usage; it is not a provider attestation that the exact selected level/budget was honored.
- **UNVERIFIED**: the request included a thinking parameter, but the response did not provide a positive count. This does not prove thinking was disabled or the parameter was ignored.
- **NOT CONFIGURED**: the app did not map the chosen level to a request parameter for that provider/model. A provider-reported token count may still be displayed, but the selected level is not considered verified.

The actual reported thinking count is saved separately in `usage_events.thinking_tokens` and does not get added to total-token quota calculations, because provider total usage may already include those tokens. The system never treats the requested budget as the actual number consumed. A positive token count verifies reported usage only; it does not prove that the provider honored the exact selected level, that the entire budget was used, or that the answer is correct. The per-response panel names the exact response field where evidence was found and explicitly records that the provider did not echo confirmation of the selected level.

## Deployment verification

1. Deploy this version and send a new chat message with High or X High selected.
2. Inspect the per-response **Thinking evidence** panel.
3. For Gemini 2.5 Pro, confirm the parameter path is `extra_body.google.thinking_config.thinking_budget` and the requested budget matches the selected level.
4. If the provider returns no recognized thinking-token field, the panel remains **UNVERIFIED**. Run the administrator's live diagnostics to see whether the gateway exposes a reasoning usage field.
5. Do not mark a response verified based only on latency, response quality, a requested budget value, or successful HTTP status.

A live provider/API-key check is still required to confirm that the specific ODiRouter route accepts and reports the request as expected. Offline tests can verify the application's payload shaping and evidence classification, but cannot prove upstream behavior without a real provider response.
