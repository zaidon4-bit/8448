'use strict';

const ALLOWED_THINKING_BUDGETS = [4096, 8192, 16384, 24576, 32768];
const ALLOWED_OUTPUT_TARGETS = [2000, 5000, 10000, 20000];
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

  // Keep OpenCode's own tool/system instructions intact, but ensure that the
  // current admin-managed prompt is present in every actual upstream request.
  let insertAt = 0;
  while (insertAt < messages.length && messages[insertAt] && ['system', 'developer'].includes(messages[insertAt].role)) insertAt++;
  messages.splice(insertAt, 0, {
    role: 'system',
    content: `Administrator-managed System Prompt (must be followed for this application):\n\n${prompt}`
  });
  return true;
}

function applyGenerationControls(requestBody, user, aiConfig, systemPrompt) {
  const parsed = structuredClone(requestBody || {});
  if (!Array.isArray(parsed.messages)) throw new Error('OpenAI-compatible request must include a messages array.');

  const modelId = String(aiConfig && aiConfig.modelId || '');
  parsed.model = modelId;
  const isGemini25Pro = /gemini[\s_\/-]*2\.?5[\s_\/-]*pro/i.test(modelId);
  const thinkingMode = user && user.thinking_mode === 'budget' ? 'budget' : 'auto';
  const rawBudget = Number(user && user.thinking_budget);
  const thinkingBudget = ALLOWED_THINKING_BUDGETS.includes(rawBudget) ? rawBudget : 8192;
  const rawTarget = Number(user && user.output_target);
  const outputTarget = ALLOWED_OUTPUT_TARGETS.includes(rawTarget) ? rawTarget : 5000;

  const promptInjected = addAdministratorPrompt(parsed.messages, systemPrompt);
  const generationInstruction = [
    'CodeCraft generation preferences for this request:',
    `- Requested answer target: about ${outputTarget.toLocaleString('en-US')} generated output tokens for substantial coding, analysis, or detailed-explanation tasks.`,
    '- Treat this as a strong length target when the task genuinely warrants detail. Do not be terse merely to be concise; complete the requested implementation, include necessary code and verification details, and explain changed files and results.',
    '- Do not pad simple greetings or narrow questions. Never invent code, tests, facts, or token usage just to reach a length target.',
    '- This target is not an API-enforced minimum; continue with useful detail when needed and stop when the task is complete.'
  ].join('\n');

  let targetMessage = null;
  for (let i = parsed.messages.length - 1; i >= 0; i--) {
    const candidate = parsed.messages[i];
    if (candidate && ['system', 'developer'].includes(candidate.role)) { targetMessage = candidate; break; }
  }
  if (!targetMessage) {
    parsed.messages.unshift({ role: 'system', content: generationInstruction });
  } else {
    appendInstruction(targetMessage, generationInstruction);
  }

  let actualThinkingBudget = null;
  let maxAllowed = outputTarget;
  if (isGemini25Pro) {
    // Google documents these settings on the OpenAI-compatible REST body as
    // extra_body.google.thinking_config.thinking_budget. Dynamic mode uses -1.
    delete parsed.reasoning_effort; // these controls overlap for Gemini
    parsed.extra_body = parsed.extra_body && typeof parsed.extra_body === 'object' && !Array.isArray(parsed.extra_body)
      ? parsed.extra_body : {};
    const previousGoogle = parsed.extra_body.google && typeof parsed.extra_body.google === 'object'
      ? parsed.extra_body.google : {};
    const previousThinkingConfig = previousGoogle.thinking_config && typeof previousGoogle.thinking_config === 'object'
      ? previousGoogle.thinking_config : {};
    actualThinkingBudget = thinkingMode === 'budget' ? thinkingBudget : -1;
    parsed.extra_body.google = {
      ...previousGoogle,
      thinking_config: { ...previousThinkingConfig, thinking_budget: actualThinkingBudget }
    };

    // Gemini counts thought tokens against the total output ceiling. Leave room
    // for maximum dynamic reasoning, or for the user's selected fixed budget.
    const thinkingReservation = thinkingMode === 'budget' ? thinkingBudget : GEMINI_25_MAX_THINKING_BUDGET;
    maxAllowed = Math.min(GEMINI_25_MAX_OUTPUT_TOKENS, outputTarget + thinkingReservation);
  }

  // Apply the selected target to the actual upstream request's output ceiling.
  if (Object.prototype.hasOwnProperty.call(parsed, 'max_completion_tokens')) {
    parsed.max_completion_tokens = maxAllowed;
    delete parsed.max_tokens;
  } else {
    parsed.max_tokens = maxAllowed;
  }

  return {
    body: parsed,
    diagnostics: {
      modelFamily: isGemini25Pro ? 'gemini-2.5-pro' : 'other',
      thinkingMode,
      thinkingBudget: actualThinkingBudget,
      outputTarget,
      maxAllowed,
      systemPromptIncluded: Boolean(systemPrompt && parsed.messages.some(message =>
        message && ['system', 'developer'].includes(message.role) && messageText(message.content).includes(String(systemPrompt).trim()))),
      systemPromptInjected: promptInjected
    }
  };
}

module.exports = {
  ALLOWED_THINKING_BUDGETS,
  ALLOWED_OUTPUT_TARGETS,
  applyGenerationControls
};
