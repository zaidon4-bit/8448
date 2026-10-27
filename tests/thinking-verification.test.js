import test from "node:test";
import assert from "node:assert/strict";
import { buildThinkingVerification, extractThinkingUsage, summarizeUsage } from "../server/thinking-verification.js";

const settings = { thinkingLevel: "high", additionalMode: "standard", reasoningParameterApplied: true,
  thinkingField: "extra_body.google.thinking_config.thinking_budget", thinkingValue: 24576, thinkingBudgetTokensRequested: 24576 };

test("extracts OpenAI-compatible reasoning token evidence", () => {
  assert.deepEqual(extractThinkingUsage({ usage: { completion_tokens_details: { reasoning_tokens: 321 } } }), {
    tokens: 321, source: "usage.completion_tokens_details.reasoning_tokens"
  });
});

test("extracts Google's native thoughts token evidence through a compatible response", () => {
  assert.deepEqual(extractThinkingUsage({ usageMetadata: { thoughtsTokenCount: 777 } }), {
    tokens: 777, source: "usageMetadata.thoughtsTokenCount"
  });
});

test("does not treat missing usage evidence as proof that thinking was disabled", () => {
  const result = buildThinkingVerification(settings, { usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } });
  assert.equal(result.status, "unverified");
  assert.equal(result.verified, false);
  assert.equal(result.actualThinkingTokens, null);
  assert.match(result.message, /cannot be verified/i);
});

test("only positive provider-reported tokens can verify actual thinking usage", () => {
  const result = buildThinkingVerification(settings, { usage: { completion_tokens_details: { reasoning_tokens: 1480 } } });
  assert.equal(result.status, "verified");
  assert.equal(result.verified, true);
  assert.equal(result.actualThinkingTokens, 1480);
  assert.equal(result.requestedBudgetTokens, 24576);
  assert.match(result.message, /did not confirm that the provider honored the exact selected level\/budget/i);
  assert.equal(result.providerConfirmedSelectedLevel, false);
  assert.equal(result.evidenceSource, "usage.completion_tokens_details.reasoning_tokens");
});

test("reported zero stays unverified and is not mislabeled as ignored parameter", () => {
  const result = buildThinkingVerification(settings, { usageMetadata: { thoughtsTokenCount: 0 } });
  assert.equal(result.status, "unverified");
  assert.equal(result.actualThinkingTokens, 0);
  assert.match(result.message, /not proof that the parameter was ignored/i);
});

test("unconfigured request cannot be marked verified just because usage reported tokens", () => {
  const result = buildThinkingVerification({ ...settings, reasoningParameterApplied: false }, { usageMetadata: { thoughtsTokenCount: 88 } });
  assert.equal(result.status, "not_configured");
  assert.equal(result.verified, false);
  assert.equal(result.actualThinkingTokens, 88);
});

test("summarizes total, completion and thinking token usage separately", () => {
  const usage = summarizeUsage({ usage: { prompt_tokens: 11, completion_tokens: 19, total_tokens: 30, completion_tokens_details: { reasoning_tokens: 7 } } });
  assert.equal(usage.prompt_tokens, 11);
  assert.equal(usage.completion_tokens, 19);
  assert.equal(usage.total_tokens, 30);
  assert.equal(usage.thinking_tokens, 7);
  assert.equal(usage.thinking_tokens_source, "usage.completion_tokens_details.reasoning_tokens");
});
