'use strict';

const ALLOWED_REASONING_LEVELS = ['low', 'medium', 'high', 'xhigh'];
const ALLOWED_OUTPUT_TARGETS = [2000, 5000, 10000, 20000];
const GEMINI_25_THINKING_BUDGETS = Object.freeze({
  low: 1024,
  medium: 8192,
  high: 24576,
  xhigh: 32768
});
const GEMINI_25_MAX_THINKING_BUDGET = 32768;
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

function appendInstruction(message, instruction) {
  if (typeof message.content === 'string' || message.content == null) {
    message.content = `${String(message.content || '').trim()}\n\n${instruction}`.trim();
    return;
  }
  if (Array.isArray(message.content)) {
    message.content.push({ type: 'text', text: instruction });
    return;
  }
  message.content = `${messageText(message.content)}\n\n${instruction}`.trim();
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
  const isGemini25Pro = /gemini[\s_\/-]*2\.?5[\s_\/-]*pro/i.test(modelId);
  const thinkingEnabled = !!(user && user.thinking_mode === 'budget');
  const requestedLevel = String(user && user.reasoning_level || 'medium').trim().toLowerCase();
  const reasoningLevel = ALLOWED_REASONING_LEVELS.includes(requestedLevel) ? requestedLevel : 'medium';
  const rawTarget = Number(user && user.output_target);
  const outputTarget = ALLOWED_OUTPUT_TARGETS.includes(rawTarget) ? rawTarget : 5000;

  const promptInjected = addAdministratorPrompt(parsed.messages, systemPrompt);
  const generationInstruction = [
    'CodeCraft response preferences for this request:',
    `- Desired visible response target: about ${outputTarget.toLocaleString('en-US')} output tokens for substantial coding, analysis, or detailed-explanation tasks.`,
    '- For substantial coding tasks, be complete rather than terse: implement the requested changes, include relevant code and verification details, and report changed files and actual test results.',
    '- For greetings and simple questions, answer briefly; do not call tools unless they are genuinely needed.',
    '- Never pad output, invent code, invent tests, or invent token usage to reach a target. A target guides the answer and is not a guaranteed minimum.'
  ].join('\n');

  let targetMessage = null;
  for (let i = parsed.messages.length - 1; i >= 0; i--) {
    const candidate = parsed.messages[i];
    if (candidate && ['system', 'developer'].includes(candidate.role)) { targetMessage = candidate; break; }
  }
  if (!targetMessage) parsed.messages.unshift({ role: 'system', content: generationInstruction });
  else appendInstruction(targetMessage, generationInstruction);

  let effectiveReasoningEffort = null;
  let thinkingBudget = null;
  let reasoningParameter = null;
  let maxAllowed = outputTarget;

  if (isGemini25Pro) {
    // Gemini 2.5 uses thinking budgets, not Gemini 3's reasoning-level API.
    // In this provider gateway, the Google-specific setting is passed through
    // the extra_body.google.thinking_config object. The adapter's real upstream
    // acceptance must still be verified with a live OdiRouter request.
    const actualThinkingBudget = thinkingEnabled ? GEMINI_25_THINKING_BUDGETS[reasoningLevel] : -1;
    thinkingBudget = actualThinkingBudget;
    setGoogleThinkingBudget(parsed, actualThinkingBudget);
    delete parsed.reasoning_effort;
    reasoningParameter = 'extra_body.google.thinking_config.thinking_budget';
    effectiveReasoningEffort = reasoningLevel;
    maxAllowed = Math.min(GEMINI_25_MAX_OUTPUT_TOKENS, outputTarget + (thinkingEnabled ? thinkingBudget : GEMINI_25_MAX_THINKING_BUDGET));
  } else if (thinkingEnabled) {
    // For non-Gemini-2.5 routes, use the OpenAI-compatible reasoning_effort
    // extension only when the selected route is not the Google 2.5 budget API.
    effectiveReasoningEffort = reasoningLevel;
    parsed.reasoning_effort = effectiveReasoningEffort;
    reasoningParameter = 'reasoning_effort';
    maxAllowed = outputTarget;
  } else {
    delete parsed.reasoning_effort;
  }

  delete parsed.max_completion_tokens;
  parsed.max_tokens = maxAllowed;

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
      modelFamily: isGemini25Pro ? 'gemini-2.5-pro' : 'other',
      thinkingEnabled,
      reasoningLevel,
      requestedReasoningLevel: reasoningLevel,
      effectiveReasoningEffort,
      thinkingBudget,
      estimatedThinkingBudget: thinkingBudget === -1 ? null : thinkingBudget,
      reasoningParameter,
      outputTarget,
      maxAllowed,
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
  ALLOWED_OUTPUT_TARGETS,
  GEMINI_25_THINKING_BUDGETS,
  applyGenerationControls
};
