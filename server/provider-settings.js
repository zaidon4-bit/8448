// Provider-aware request shaping kept pure so the exact payload mapping can be tested offline.
export function setPayloadField(payload, dottedField, value) {
  const parts = String(dottedField || "").split(".").filter(Boolean);
  if (!parts.length || parts.length > 6 || parts.some(p => !/^[a-zA-Z0-9_-]{1,80}$/.test(p) || ["__proto__", "prototype", "constructor"].includes(p))) return false;
  let target = payload;
  for (const key of parts.slice(0, -1)) {
    if (!target[key] || typeof target[key] !== "object" || Array.isArray(target[key])) target[key] = {};
    target = target[key];
  }
  target[parts[parts.length - 1]] = value;
  return true;
}

function providerHost(baseURL) {
  try { return new URL(baseURL).hostname.toLowerCase(); } catch { return ""; }
}

export function isOdiRouterGemini25Pro(baseURL, modelId) {
  const host = providerHost(baseURL);
  const model = String(modelId || "").toLowerCase().replace(/[\s_]/g, "-");
  return /(^|\.)odirouter\.ai$/.test(host) && /gemini[-/]?2[.-]?5.*pro/.test(model);
}

// Google's documented Gemini 2.5 OpenAI-compat mapping uses thinking budgets, not reasoning_effort.
// X High is an app-level alias for the model's maximum supported budget, not a separate provider tier.
export const GEMINI_25_PRO_THINKING_BUDGETS = Object.freeze({
  low: 1024,
  medium: 8192,
  high: 24576,
  xhigh: 32768
});
const GEMINI_25_BUDGET_PATH = "extra_body.google.thinking_config.thinking_budget";

export function applyProviderSettings(payload, settings, modelId, baseURL = "", modelSettings = null, env = process.env) {
  const thinkingLevel = ["low", "medium", "high", "xhigh"].includes(settings?.thinkingLevel) ? settings.thinkingLevel : "high";
  const additionalMode = ["standard", "quick", "long", "deep"].includes(settings?.additionalMode) ? settings.additionalMode : "standard";
  const odirouterGemini25Pro = isOdiRouterGemini25Pro(baseURL, modelId);
  const hasExactAdminThinkingOverride = modelSettings?.configuredModelId === modelId && Boolean(modelSettings?.thinking_field);
  const useGemini25BudgetPreset = odirouterGemini25Pro && !hasExactAdminThinkingOverride;
  // A generic .env mapping such as reasoning_effort must not override the Gemini 2.5 budget preset.
  const configuredThinkingField = useGemini25BudgetPreset ? "" : (modelSettings?.thinking_field || env.AI_THINKING_FIELD || "");
  const thinkingField = configuredThinkingField;
  const valueMap = {
    low: modelSettings?.thinking_low_value || env.AI_THINKING_LOW_VALUE || "low",
    medium: modelSettings?.thinking_medium_value || env.AI_THINKING_MEDIUM_VALUE || "medium",
    high: modelSettings?.thinking_high_value || env.AI_THINKING_HIGH_VALUE || "high",
    xhigh: modelSettings?.thinking_xhigh_value || (odirouterGemini25Pro ? "high" : (env.AI_THINKING_XHIGH_VALUE || "xhigh"))
  };
  const outputField = modelSettings?.max_output_field || (odirouterGemini25Pro ? "max_tokens" : (env.AI_MAX_OUTPUT_FIELD || "max_completion_tokens"));
  const budgetField = modelSettings?.thinking_budget_field || env.AI_THINKING_BUDGET_FIELD || "";
  let thinkingValue = null;
  let thinkingFieldApplied = null;
  let thinkingBudgetTokensRequested = null;
  let deepBudgetConfigured = false;
  let deepBudgetFieldApplied = null;
  let deepBudgetTokensRequested = null;

  if (additionalMode !== "deep" && useGemini25BudgetPreset) {
    thinkingValue = GEMINI_25_PRO_THINKING_BUDGETS[thinkingLevel];
    if (setPayloadField(payload, GEMINI_25_BUDGET_PATH, thinkingValue)) {
      thinkingFieldApplied = GEMINI_25_BUDGET_PATH;
      thinkingBudgetTokensRequested = thinkingValue;
    }
  } else if (additionalMode !== "deep" && thinkingField) {
    thinkingValue = valueMap[thinkingLevel];
    if (setPayloadField(payload, thinkingField, thinkingValue)) thinkingFieldApplied = thinkingField;
    if (thinkingField.toLowerCase().includes("thinking_budget") && Number.isFinite(Number(thinkingValue))) {
      thinkingBudgetTokensRequested = Number(thinkingValue);
    }
  }

  let outputFieldApplied = null;
  if (additionalMode === "long" && setPayloadField(payload, outputField, 10000)) outputFieldApplied = outputField;
  if (additionalMode === "deep") {
    if (budgetField && !(odirouterGemini25Pro && !hasExactAdminThinkingOverride)) {
      deepBudgetConfigured = setPayloadField(payload, budgetField, 10000);
      deepBudgetFieldApplied = deepBudgetConfigured ? budgetField : null;
      deepBudgetTokensRequested = deepBudgetConfigured ? 10000 : null;
      if (thinkingField === "reasoning_effort") delete payload.reasoning_effort;
    } else if (odirouterGemini25Pro && !hasExactAdminThinkingOverride) {
      // For Gemini 2.5 Pro, keep the request to the documented budget field and avoid reasoning_effort.
      delete payload.reasoning_effort;
      deepBudgetFieldApplied = GEMINI_25_BUDGET_PATH;
      deepBudgetConfigured = setPayloadField(payload, deepBudgetFieldApplied, 10000);
      if (!deepBudgetConfigured) deepBudgetFieldApplied = null;
      deepBudgetTokensRequested = deepBudgetConfigured ? 10000 : null;
      thinkingBudgetTokensRequested = deepBudgetTokensRequested;
    } else if (thinkingField) {
      thinkingValue = valueMap.xhigh;
      if (setPayloadField(payload, thinkingField, thinkingValue)) thinkingFieldApplied = thinkingField;
    }
  }

  return {
    thinkingLevel, additionalMode,
    thinkingField: thinkingFieldApplied,
    thinkingValue: thinkingFieldApplied ? thinkingValue : null,
    thinkingFieldConfigured: Boolean(thinkingField || useGemini25BudgetPreset),
    reasoningParameterApplied: Boolean(thinkingFieldApplied || deepBudgetConfigured),
    thinkingBudgetTokensRequested,
    deepBudgetConfigured, deepBudgetField: deepBudgetFieldApplied, deepBudgetTokensRequested,
    outputField: outputFieldApplied,
    outputTokenLimitRequested: outputFieldApplied ? 10000 : null,
    providerPreset: useGemini25BudgetPreset ? "odirouter-gemini-2.5-pro-thinking-budget" : (configuredThinkingField ? "admin-configured" : "provider-default")
  };
}
