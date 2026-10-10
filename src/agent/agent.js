'use strict';
/**
 * The agent loop: customer message in, reply text out.
 *
 * Plain OpenAI tool calling, no framework. The loop is bounded (AGENT_MAX_STEPS) so
 * a confused model cannot spin forever on the client's token budget. Every reply
 * passes through the guards before it leaves this file - that is the whole point of
 * having them, so no caller can forget.
 */

const log = require('../log');
const { buildSystemPrompt } = require('./prompt');
const { toolSchemas, runTool } = require('./tools');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Crude but sufficient: decide the reply language from the customer's own text. */
function detectLang(history) {
  const lastUser = [...history].reverse().find((m) => m.role === 'user');
  const text = String(lastUser?.content || '');
  if (!text) return 'de';
  const de = /\b(ich|und|nicht|das|ist|für|wie|kann|hallo|guten|deko|geburtstag|miete)\b/i;
  const en = /\b(the|and|not|is|how|can|hello|hi|birthday|rent|available|price)\b/i;
  const deHits = (text.match(de) || []).length;
  const enHits = (text.match(en) || []).length;
  if (enHits > deHits) return 'en';
  return 'de';
}

/**
 * @param {object} deps
 * @param {object} deps.openai    OpenAI client (or any object with chat.completions.create)
 * @param {object} deps.knowledge knowledge pack
 * @param {object} deps.guards    from createGuards()
 * @param {object} [deps.config]
 */
function createAgent({ openai, knowledge, guards, config = {} }) {
  const model = config.model || process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const maxSteps = Number(config.maxSteps || process.env.AGENT_MAX_STEPS || 6);
  const maxRetries = Number(config.maxRetries || process.env.OPENAI_MAX_RETRIES || 2);
  const timeoutMs = Number(config.timeoutMs || process.env.OPENAI_TIMEOUT_MS || 30000);

  async function callModel(messages) {
    let lastErr;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await openai.chat.completions.create(
          { model, messages, tools: toolSchemas(), tool_choice: 'auto', temperature: 0.4 },
          { timeout: timeoutMs }
        );
      } catch (err) {
        lastErr = err;
        const retryable = !err.status || err.status === 429 || err.status >= 500;
        if (!retryable || attempt === maxRetries) break;
        const wait = 500 * 2 ** attempt;
        log.warn(`OpenAI call failed (${err.status || err.code || err.message}), retry in ${wait}ms`);
        await sleep(wait);
      }
    }
    throw lastErr;
  }

  /**
   * @param {object} input
   * @param {Array<{role:string,content:string}>} input.history  prior turns, oldest first
   * @param {string} input.message        the new customer message
   * @param {object} [input.services]     injected tool services
   * @param {string} [input.chatId]
   * @param {string} [input.customerName]
   * @returns {Promise<{text:string, toolCalls:object[], handoff:boolean, violations:object[], blocked:boolean}>}
   */
  async function reply({ history = [], message, services = {}, chatId, customerName }) {
    const lang = detectLang([...history, { role: 'user', content: message }]);
    const system = buildSystemPrompt(knowledge, {
      today: new Date().toLocaleDateString('en-CA', { timeZone: process.env.TZ || 'Europe/Zurich' }),
      customerName,
    });

    const messages = [
      { role: 'system', content: system },
      ...history.map((m) => ({ role: m.role, content: m.content })),
      { role: 'user', content: message },
    ];

    let handoff = false;
    const toolCalls = [];
    const toolServices = {
      ...services,
      chatId,
      onHandoff: () => {
        handoff = true;
      },
    };

    for (let step = 0; step < maxSteps; step++) {
      const res = await callModel(messages);
      const choice = res.choices?.[0];
      const msg = choice?.message;
      if (!msg) throw new Error('OpenAI returned no message');

      if (msg.tool_calls?.length) {
        messages.push(msg);
        for (const call of msg.tool_calls) {
          let args = {};
          try {
            args = JSON.parse(call.function.arguments || '{}');
          } catch {
            log.warn(`Tool ${call.function.name} sent invalid JSON arguments`);
          }
          const result = await runTool(call.function.name, args, toolServices);
          toolCalls.push({ name: call.function.name, args, result });
          log.info(`tool ${call.function.name} -> ${result.ok ? 'ok' : `error: ${result.error}`}`);
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify(result),
          });
        }
        continue; // let the model use the results
      }

      const guarded = guards.enforce(msg.content || '', { lang });
      if (guarded.blocked) {
        log.error(
          `Guard blocked a reply: ${guarded.violations.map((v) => v.code).join(', ')} | ` +
            guarded.violations.map((v) => `"${v.sentence}"`).join(' ')
        );
        handoff = true;
      }
      return { ...guarded, toolCalls, handoff, lang };
    }

    log.warn(`Agent hit the step limit (${maxSteps}) without a final answer`);
    return {
      text:
        lang === 'en'
          ? 'Let me pass this to a colleague - they will get back to you.'
          : 'Ich gebe das an jemanden aus dem Team weiter, du hoerst gleich von uns.',
      toolCalls,
      handoff: true,
      violations: [],
      blocked: false,
      lang,
    };
  }

  return { reply, detectLang };
}

module.exports = { createAgent, detectLang };
