import test from "node:test";
import assert from "node:assert/strict";
import { applyProviderSettings, GEMINI_25_PRO_THINKING_BUDGETS, isOdiRouterGemini25Pro, setPayloadField } from "../server/provider-settings.js";

const baseURL = "https://api.odirouter.ai/v1";
const geminiModel = "google/gemini-2.5-pro:free";

function payload() {
  return { model: geminiModel, messages: [{ role: "user", content: "OK" }] };
}

test("detects only the ODiRouter Gemini 2.5 Pro route", () => {
  assert.equal(isOdiRouterGemini25Pro(baseURL, geminiModel), true);
  assert.equal(isOdiRouterGemini25Pro("https://api.odirouter.ai/v1", "google/gemini-2.5-flash:free"), false);
  assert.equal(isOdiRouterGemini25Pro("https://api.other.example/v1", geminiModel), false);
});

test("maps all four Gemini 2.5 Pro choices to documented budget field, not reasoning_effort", () => {
  for (const level of ["low", "medium", "high", "xhigh"]) {
    const body = payload();
    // A generic environment mapping must not accidentally override the Gemini 2.5 budget preset.
    const applied = applyProviderSettings(body, { thinkingLevel: level, additionalMode: "standard" }, geminiModel, baseURL, { configuredModelId: "*", thinking_field: "" }, {
      AI_THINKING_FIELD: "reasoning_effort", AI_THINKING_LOW_VALUE: "low", AI_THINKING_MEDIUM_VALUE: "medium", AI_THINKING_HIGH_VALUE: "high", AI_THINKING_XHIGH_VALUE: "xhigh", AI_MAX_OUTPUT_FIELD: "max_completion_tokens"
    });
    assert.equal(applied.reasoningParameterApplied, true, `${level} should apply a reasoning control`);
    assert.equal(body.reasoning_effort, undefined);
    assert.equal(body.extra_body.google.thinking_config.thinking_budget, GEMINI_25_PRO_THINKING_BUDGETS[level]);
    assert.equal(applied.thinkingField, "extra_body.google.thinking_config.thinking_budget");
    assert.equal(applied.thinkingBudgetTokensRequested, GEMINI_25_PRO_THINKING_BUDGETS[level]);
  }
});

test("Gemini 2.5 Pro X High maps to its max supported thinking budget", () => {
  const body = payload();
  const applied = applyProviderSettings(body, { thinkingLevel: "xhigh", additionalMode: "standard" }, geminiModel, baseURL, null, {});
  assert.equal(body.extra_body.google.thinking_config.thinking_budget, 32768);
  assert.equal(applied.thinkingValue, 32768);
  assert.equal(applied.providerPreset, "odirouter-gemini-2.5-pro-thinking-budget");
});

test("deep mode sends its own explicit budget without reasoning_effort", () => {
  const body = payload();
  const applied = applyProviderSettings(body, { thinkingLevel: "high", additionalMode: "deep" }, geminiModel, baseURL, null, { AI_THINKING_FIELD: "reasoning_effort" });
  assert.equal(body.reasoning_effort, undefined);
  assert.equal(body.extra_body.google.thinking_config.thinking_budget, 10000);
  assert.equal(applied.deepBudgetTokensRequested, 10000);
  assert.equal(applied.thinkingBudgetTokensRequested, 10000);
  assert.equal(applied.deepBudgetField, "extra_body.google.thinking_config.thinking_budget");
  assert.equal(applied.reasoningParameterApplied, true);
});

test("long mode applies an output-token cap and reports the exact field", () => {
  const body = payload();
  const applied = applyProviderSettings(body, { thinkingLevel: "medium", additionalMode: "long" }, geminiModel, baseURL, null, {});
  assert.equal(body.max_tokens, 10000);
  assert.equal(body.max_completion_tokens, undefined);
  assert.equal(applied.outputField, "max_tokens");
  assert.equal(applied.outputTokenLimitRequested, 10000);
  assert.equal(body.extra_body.google.thinking_config.thinking_budget, 8192);
});

test("non-ODiRouter models do not get guessed reasoning controls", () => {
  const body = { messages: [{ role: "user", content: "OK" }] };
  const applied = applyProviderSettings(body, { thinkingLevel: "high", additionalMode: "standard" }, "some-model", "https://api.example.com/v1", null, {});
  assert.equal(applied.reasoningParameterApplied, false);
  assert.equal(body.reasoning_effort, undefined);
});

test("admin-configured model field is honored and protected path segments are rejected", () => {
  const body = {};
  const configured = { configuredModelId: "custom-model", thinking_field: "reasoning.effort", thinking_low_value: "small", thinking_medium_value: "balanced", thinking_high_value: "strong", thinking_xhigh_value: "max", max_output_field: "max_tokens" };
  const applied = applyProviderSettings(body, { thinkingLevel: "xhigh", additionalMode: "standard" }, "custom-model", "https://provider.example/v1", configured, {});
  assert.deepEqual(body.reasoning, { effort: "max" });
  assert.equal(applied.thinkingField, "reasoning.effort");
  assert.equal(setPayloadField(body, "__proto__.polluted", true), false);
  assert.equal({}.polluted, undefined);
});
