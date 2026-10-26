
'use strict';

const ALLOWED_REASONING_LEVELS = ['low', 'medium', 'high', 'xhigh'];
const GEMINI_25_THINKING_BUDGETS = Object.freeze({
  low: 1024,
  medium: 8192,
  high: 24576,
  // X-High is the UI name for Gemini 2.5 Pro's maximum supported budget.
  xhigh: 32768
});
const GEMINI_25_MAX_OUTPUT_TOKENS = 65536;

function messageText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(part => {
      if (typeof part === 'string') return part;
      if (part && typeof part.text === 'string') return part.text;
      return '';
    }).join('\n');
  }
  return '';
}

function addAdministratorPrompt(messages, systemPrompt) {
  const prompt = String(systemPrompt || '').trim();
  if (!prompt) return false;
  const systemMessages = messages.filter(message => message && ['system', 'developer'].includes(message.role));
  if (systemMessages.some(message => messageText(message.content).includes(prompt))) return false;
  let insertAt = 0;
  while (insertAt < messages.length && messages[insertAt] && ['system', 'developer'].includes(messages[insertAt].role)) insertAt++;
  messages.splice(insertAt, 0, {
    role: 'system',
    content: `Administrator-managed System Prompt (must be followed for this application):\n\n${prompt}`
  });
  return true;
}

function isGemini25ProModel(modelId) {
  return /(?:^|[^a-z0-9])gemini[\s_\/-]*2\.?5[\s_\/-]*pro(?:$|[^a-z0-9])/i.test(String(modelId || ''));
}

function getOpenCodeModelCapabilities(modelId) {
  const isGemini25Pro = isGemini25ProModel(modelId);
  return {
    tool_call: true,
    reasoning: true,
    limit: {
      context: isGemini25Pro ? 1_048_576 : 200_000,
      output: 65_536
    }
  };
}

function setGoogleThinkingBudget(body, actualThinkingBudget) {
  const extraBody = body.extra_body && typeof body.extra_body === 'object' && !Array.isArray(body.extra_body)
    ? body.extra_body : {};
  const google = extraBody.google && typeof extraBody.google === 'object' && !Array.isArray(extraBody.google)
    ? extraBody.google : {};
  const thinkingConfig = google.thinking_config && typeof google.thinking_config === 'object' && !Array.isArray(google.thinking_config)
    ? google.thinking_config : {};
  body.extra_body = {
    ...extraBody,
    google: {
      ...google,
      thinking_config: { ...thinkingConfig, thinking_budget: actualThinkingBudget }
    }
  };
}

function applyGenerationControls(requestBody, user, aiConfig, systemPrompt) {
  const parsed = structuredClone(requestBody || {});
  if (!Array.isArray(parsed.messages)) throw new Error('OpenAI-compatible request must include a messages array.');

  const modelId = String(aiConfig && aiConfig.modelId || '');
  parsed.model = modelId;
  const isGemini25Pro = isGemini25ProModel(modelId);
  const thinkingEnabled = !!(user && user.thinking_mode === 'budget');
  const requestedLevel = String(user && user.reasoning_level || 'medium').trim().toLowerCase();
  const reasoningLevel = ALLOWED_REASONING_LEVELS.includes(requestedLevel) ? requestedLevel : 'medium';
  const promptInjected = addAdministratorPrompt(parsed.messages, systemPrompt);

  let effectiveReasoningEffort = null;
  let thinkingBudget = null;
  let reasoningParameter = null;
  let maxOutputTokens = null;

  if (isGemini25Pro) {
    // Gemini 2.5 Pro uses a thinking budget rather than a named xhigh API level.
    // An unchecked toggle restores dynamic/default thinking; Pro still thinks internally.
    const actualThinkingBudget = thinkingEnabled ? GEMINI_25_THINKING_BUDGETS[reasoningLevel] : -1;
    thinkingBudget = actualThinkingBudget;
    setGoogleThinkingBudget(parsed, actualThinkingBudget);
    delete parsed.reasoning_effort;
    reasoningParameter = 'extra_body.google.thinking_config.thinking_budget';
    effectiveReasoningEffort = thinkingEnabled ? reasoningLevel : null;
    // Do not impose a user-selected short answer ceiling. Gemini's output limit includes
    // thought tokens, and a low ceiling can yield a long wait followed by empty text.
    delete parsed.max_completion_tokens;
    parsed.max_tokens = GEMINI_25_MAX_OUTPUT_TOKENS;
    maxOutputTokens = parsed.max_tokens;
  } else if (thinkingEnabled) {
    effectiveReasoningEffort = reasoningLevel;
    parsed.reasoning_effort = effectiveReasoningEffort;
    reasoningParameter = 'reasoning_effort';
    // Preserve the provider/OpenCode output limit; this app does not set response-length targets.
    maxOutputTokens = Number.isFinite(Number(parsed.max_tokens)) ? Number(parsed.max_tokens) : null;
  } else {
    delete parsed.reasoning_effort;
    maxOutputTokens = Number.isFinite(Number(parsed.max_tokens)) ? Number(parsed.max_tokens) : null;
  }

  const toolItems = Array.isArray(parsed.tools) ? parsed.tools : [];
  const toolDefinitions = toolItems.length;
  const toolNames = [...new Set(toolItems.map(tool => {
    if (!tool || typeof tool !== 'object') return '';
    const name = tool.function && typeof tool.function.name === 'string' ? tool.function.name : tool.name;
    return typeof name === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(name) ? name : '';
  }).filter(Boolean))].slice(0, 40);
  return {
    body: parsed,
    diagnostics: {
      modelId,
      modelFamily: isGemini25Pro ? 'gemini-2.5-pro' : 'other',
      thinkingEnabled,
      reasoningLevel,
      requestedReasoningLevel: reasoningLevel,
      effectiveReasoningEffort,
      thinkingBudget,
      estimatedThinkingBudget: thinkingBudget === -1 ? null : thinkingBudget,
      reasoningParameter,
      maxOutputTokens,
      toolDefinitions,
      toolNames,
      toolChoice: typeof parsed.tool_choice === 'string' ? parsed.tool_choice : (parsed.tool_choice ? 'structured' : 'unspecified'),
      systemPromptIncluded: Boolean(systemPrompt && parsed.messages.some(message =>
        message && ['system', 'developer'].includes(message.role) && messageText(message.content).includes(String(systemPrompt).trim()))),
      systemPromptInjected: promptInjected
    }
  };
}

module.exports = {
  ALLOWED_REASONING_LEVELS,
  GEMINI_25_THINKING_BUDGETS,
  isGemini25ProModel,
  getOpenCodeModelCapabilities,
  applyGenerationControls
};
