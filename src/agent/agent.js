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
const { resolveLanguage, scoreText } = require('./language');
const settings = require('../settings');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MAX_AUTO_CARDS = 3;

/**
 * The model is told to show products with send_product (picture + price + link),
 * but it sometimes writes them as a text list of links instead. On WhatsApp that
 * is a wall of URLs and no pictures. When that happens, the products it named are
 * sent as picture cards here, and their lines are taken out of the text.
 *
 * Only products from this turn's search results count, so nothing is invented.
 * @returns {Promise<{text:string, sent:object[]}>}
 */
async function sendListedProducts(text, toolCalls, services, chatId) {
  const out = { text, sent: [] };
  if (!services.messenger || !services.catalog || !chatId) return out;
  if (toolCalls.some((c) => c.name === 'send_product' && c.result?.ok)) return out;

  const found = toolCalls
    .filter((c) => c.name === 'search_products' && c.result?.ok)
    .flatMap((c) => c.result.products || []);
  const seen = new Set();
  const listed = found.filter((p) => {
    if (!p || seen.has(p.id)) return false;
    const hit = (p.url && text.includes(p.url)) || (p.title && p.title.length > 5 && text.includes(p.title));
    if (hit) seen.add(p.id);
    return hit;
  });
  if (!listed.length) return out;

  for (const p of listed.slice(0, MAX_AUTO_CARDS)) {
    try {
      const product = await services.catalog.byId(p.id);
      if (!product) continue;
      await services.messenger.sendProduct(chatId, product);
      out.sent.push(p);
    } catch (err) {
      log.warn(`Could not send the product card for ${p.id}: ${err.message}`);
    }
  }
  if (!out.sent.length) return out;

  // Drop the lines that only repeated what the cards now show.
  const sentTerms = out.sent.flatMap((p) => [p.url, p.title].filter(Boolean));
  const lines = text.split('\n').filter((line) => !sentTerms.some((term) => line.includes(term)));
  // "Here are some sets:" now introduces nothing, since the cards went out first.
  const kept = lines.filter((line, i) => !(/:\s*$/.test(line) && !lines.slice(i + 1).some((l) => l.trim() && !/:\s*$/.test(l) && /^\s*[-•*\d]/.test(l))));
  out.text = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  log.info(`Model listed ${listed.length} product(s) as text - sent ${out.sent.length} as picture cards instead`);
  return out;
}

/**
 * Settings need storage; in unit tests there is none, so fall back to auto.
 * 'dashboard' means: answer in whatever language the dashboard is switched to
 * (DE/EN toggle top right). Meant for testing; switch back to 'auto' for live use.
 */
function safeSetting() {
  try {
    const value = settings.get('botLanguage');
    if (value === 'dashboard') return settings.get('dashboardLanguage') === 'en' ? 'en' : 'de';
    return value;
  } catch {
    return 'auto';
  }
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
  async function reply({ history = [], message, services = {}, chatId, customerName, langSetting }) {
    const setting = langSetting || safeSetting();
    const { lang, source } = resolveLanguage({ message, history, setting });
    const system = buildSystemPrompt(knowledge, {
      today: new Date().toLocaleDateString('en-CA', { timeZone: process.env.TZ || 'Europe/Zurich' }),
      customerName,
      lang,
      langSource: source,
    });
    log.debug(`Reply language: ${lang} (${source})`);

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

      // Products written as a list of links -> send them as picture cards instead.
      const cards = await sendListedProducts(msg.content || '', toolCalls, services, chatId);
      for (const p of cards.sent) {
        toolCalls.push({ name: 'send_product', args: { product_id: p.id }, result: { ok: true, sent: p.title, auto: true } });
      }

      const guarded = guards.enforce(cards.text, { lang });
      if (guarded.blocked) {
        log.error(
          `Guard blocked a reply: ${guarded.violations.map((v) => v.code).join(', ')} | ` +
            guarded.violations.map((v) => `"${v.sentence}"`).join(' ')
        );
        handoff = true;
      }
      return { ...guarded, toolCalls, handoff, lang };
    }

    // Usually a tool that keeps rejecting the model's arguments, so it retries
    // forever. The owner needs to know, because the conversation stops here.
    log.warn(
      `Agent hit the step limit (${maxSteps}) without a final answer. ` +
        `Tools called: ${toolCalls.map((c) => `${c.name}${c.result?.ok === false ? '(failed)' : ''}`).join(', ') || 'none'}`
    );
    return {
      text:
        lang === 'en'
          ? 'Let me pass this to a colleague - they will get back to you.'
          : 'Ich gebe das an jemanden aus dem Team weiter, du hoerst gleich von uns.',
      toolCalls,
      handoff: true,
      stepLimit: true,
      violations: [],
      blocked: false,
      lang,
    };
  }

  return { reply };
}

module.exports = { createAgent, sendListedProducts };
