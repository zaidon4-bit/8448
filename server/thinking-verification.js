const tokenCandidates = [
  [r => r?.usage?.completion_tokens_details?.reasoning_tokens, "usage.completion_tokens_details.reasoning_tokens"],
  [r => r?.usage?.output_tokens_details?.reasoning_tokens, "usage.output_tokens_details.reasoning_tokens"],
  [r => r?.usage?.completion_tokens_details?.thoughts_tokens, "usage.completion_tokens_details.thoughts_tokens"],
  [r => r?.usage?.output_tokens_details?.thoughts_tokens, "usage.output_tokens_details.thoughts_tokens"],
  [r => r?.usage?.completion_tokens_details?.thoughtsTokenCount, "usage.completion_tokens_details.thoughtsTokenCount"],
  [r => r?.usage?.output_tokens_details?.thoughtsTokenCount, "usage.output_tokens_details.thoughtsTokenCount"],
  [r => r?.usage?.reasoning_tokens, "usage.reasoning_tokens"],
  [r => r?.usage?.reasoningTokens, "usage.reasoningTokens"],
  [r => r?.usage?.thinking_tokens, "usage.thinking_tokens"],
  [r => r?.usage?.thoughts_tokens, "usage.thoughts_tokens"],
  [r => r?.usage?.thoughtsTokenCount, "usage.thoughtsTokenCount"],
  [r => r?.usageMetadata?.thoughtsTokenCount, "usageMetadata.thoughtsTokenCount"],
  [r => r?.usageMetadata?.thoughts_token_count, "usageMetadata.thoughts_token_count"],
  [r => r?.usage_metadata?.thoughts_token_count, "usage_metadata.thoughts_token_count"],
  [r => r?.usage_metadata?.thoughtsTokenCount, "usage_metadata.thoughtsTokenCount"],
  [r => r?.usage?.completionTokensDetails?.reasoningTokens, "usage.completionTokensDetails.reasoningTokens"],
  [r => r?.usage?.outputTokensDetails?.reasoningTokens, "usage.outputTokensDetails.reasoningTokens"],
  [r => r?.usage?.completionTokensDetails?.thoughtsTokenCount, "usage.completionTokensDetails.thoughtsTokenCount"]
];

function parsedCount(raw) {
  if (raw === null || raw === undefined || (typeof raw === "string" && !raw.trim())) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

export function extractThinkingUsage(response) {
  for (const [getValue, source] of tokenCandidates) {
    let raw;
    try { raw = getValue(response); } catch { raw = null; }
    const tokens = parsedCount(raw);
    if (tokens !== null) return { tokens, source };
  }
  return { tokens: null, source: null };
}

export function summarizeUsage(response) {
  const rawUsage = response?.usage || null;
  const thinking = extractThinkingUsage(response);
  const rawInput = rawUsage?.prompt_tokens ?? rawUsage?.input_tokens;
  const rawOutput = rawUsage?.completion_tokens ?? rawUsage?.output_tokens;
  const rawTotal = rawUsage?.total_tokens;
  const inputTokens = rawInput == null ? null : parsedCount(rawInput);
  const outputTokens = rawOutput == null ? null : parsedCount(rawOutput);
  let totalTokens = rawTotal == null ? null : parsedCount(rawTotal);
  if (totalTokens == null && (inputTokens !== null || outputTokens !== null)) totalTokens = (inputTokens || 0) + (outputTokens || 0);
  if (inputTokens === null && outputTokens === null && totalTokens === null && thinking.tokens === null) return null;
  return {
    prompt_tokens: inputTokens,
    input_tokens: inputTokens,
    completion_tokens: outputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    thinking_tokens: thinking.tokens,
    thinking_tokens_source: thinking.source
  };
}

export function buildThinkingVerification(appliedSettings, response) {
  const evidence = extractThinkingUsage(response);
  const parameterSent = appliedSettings?.reasoningParameterApplied === true;
  const level = appliedSettings?.thinkingLevel || null;
  const requestedBudgetTokens = parsedCount(
    appliedSettings?.thinkingBudgetTokensRequested ?? appliedSettings?.deepBudgetTokensRequested
  );
  const parameterPath = appliedSettings?.thinkingField || appliedSettings?.deepBudgetField || null;
  const parameterValue = appliedSettings?.thinkingField
    ? (appliedSettings?.thinkingValue ?? null)
    : (appliedSettings?.deepBudgetTokensRequested ?? null);

  let status = "unverified";
  let message = "The provider/gateway returned no readable thinking-token count. Actual thinking usage cannot be verified for this response.";
  if (!parameterSent) {
    status = "not_configured";
    message = evidence.tokens > 0
      ? `The provider reported ${evidence.tokens} thinking tokens, but this app did not configure the selected thinking level for this model.`
      : "The selected thinking level was not mapped to a supported/configured request parameter; the requested level is not verified.";
  } else if (evidence.tokens > 0) {
    status = "verified";
    message = `The provider reported ${evidence.tokens.toLocaleString("en-US")} thinking tokens. This confirms reported thinking usage only; the response did not confirm that the provider honored the exact selected level/budget, that the full budget was consumed, or that the answer is correct.`;
  } else if (evidence.tokens === 0) {
    status = "unverified";
    message = "The provider reported zero thinking tokens for this response. This is not proof that the parameter was ignored; some responses need no reported thinking tokens or the gateway may omit the metric.";
  }

  return {
    status,
    verified: status === "verified",
    selectedLevel: level,
    additionalMode: appliedSettings?.additionalMode || null,
    parameterSent,
    parameterPath,
    parameterValue,
    requestedBudgetTokens,
    actualThinkingTokens: evidence.tokens,
    evidenceSource: evidence.source,
    providerConfirmedSelectedLevel: false,
    message
  };
}
