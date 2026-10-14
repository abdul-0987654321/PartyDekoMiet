'use strict';
/**
 * Agent loop tests. The model is faked: each test queues the assistant messages
 * the loop should receive, so the tool plumbing, the guards and the handoff logic
 * are tested without an OpenAI key or a network call.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { createAgent } = require('../src/agent/agent');
const { resolveLanguage } = require('../src/agent/language');
const { createGuards } = require('../src/agent/guards');
const knowledge = require('../src/knowledge/from-files').load();

const guards = createGuards({
  faqAnswers: knowledge.faq.flatMap((e) => [e.a_de, e.a_en]),
  depositChf: 50,
  lateFeeChf: 50,
});

/** Queues scripted assistant messages; records what the loop sent. */
function fakeModel(queue) {
  const seen = [];
  return {
    seen,
    client: {
      chat: {
        completions: {
          create: async ({ messages }) => {
            seen.push(messages);
            const next = queue.shift();
            if (!next) throw new Error('fake model ran out of scripted replies');
            return { choices: [{ message: next }] };
          },
        },
      },
    },
  };
}

const text = (content) => ({ role: 'assistant', content });
const call = (name, args) => ({
  role: 'assistant',
  content: null,
  tool_calls: [{ id: `c_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
});

function agentWith(queue, config = {}) {
  const fake = fakeModel(queue);
  return {
    fake,
    agent: createAgent({ openai: fake.client, knowledge, guards, config: { maxRetries: 0, ...config } }),
  };
}

describe('agent: plain answers', () => {
  test('returns a clean reply untouched', async () => {
    const { agent } = agentWith([text('Hoi! Wie alt wird das Geburtstagskind?')]);
    const out = await agent.reply({ message: 'hallo' });
    assert.strictEqual(out.text, 'Hoi! Wie alt wird das Geburtstagskind?');
    assert.strictEqual(out.blocked, false);
    assert.strictEqual(out.handoff, false);
  });

  test('sends the system prompt and the customer message', async () => {
    const { agent, fake } = agentWith([text('ok')]);
    await agent.reply({ message: 'habt ihr Einhorn Deko?' });
    const sent = fake.seen[0];
    assert.strictEqual(sent[0].role, 'system');
    assert.match(sent[0].content, /Langstrasse 175/);
    assert.deepStrictEqual(sent.at(-1), { role: 'user', content: 'habt ihr Einhorn Deko?' });
  });

  test('passes prior history through', async () => {
    const { agent, fake } = agentWith([text('ok')]);
    await agent.reply({
      history: [
        { role: 'user', content: 'hallo' },
        { role: 'assistant', content: 'Hoi!' },
      ],
      message: 'und der Preis?',
    });
    const roles = fake.seen[0].map((m) => m.role);
    assert.deepStrictEqual(roles, ['system', 'user', 'assistant', 'user']);
  });
});

describe('agent: guards are not optional', () => {
  test('a confirmed-booking reply is blocked and becomes a handoff', async () => {
    const { agent } = agentWith([text('Super, deine Buchung ist bestaetigt!')]);
    const out = await agent.reply({ message: 'ist das Set frei am 5. Juni?' });
    assert.ok(out.blocked);
    assert.ok(out.handoff, 'a blocked reply must reach a human');
    assert.ok(!out.text.includes('bestaetigt'));
    assert.strictEqual(out.violations[0].code, 'CONFIRMED_BOOKING');
  });

  test('a delivery offer is blocked', async () => {
    const { agent } = agentWith([text('Klar, wir liefern dir die Deko nach Hause.')]);
    const out = await agent.reply({ message: 'koennt ihr liefern?' });
    assert.ok(out.blocked);
    assert.strictEqual(out.violations[0].code, 'DELIVERY_OFFERED');
  });

  test('the sharp s is fixed silently, without blocking', async () => {
    const { agent } = agentWith([text('Die Deko wird an der Strasse abgeholt, größer geht nicht.')]);
    const out = await agent.reply({ message: 'wo abholen?' });
    assert.strictEqual(out.blocked, false);
    assert.ok(!out.text.includes('ß'));
    assert.ok(out.sharpSFixed);
  });
});

describe('agent: tools', () => {
  test('reports a tool as unavailable instead of crashing', async () => {
    const { agent } = agentWith([
      call('search_products', { query: 'Einhorn' }),
      text('Das kann ich gerade nicht pruefen, ich gebe das weiter.'),
    ]);
    const out = await agent.reply({ message: 'habt ihr Einhorn Sets?' });
    assert.strictEqual(out.toolCalls.length, 1);
    assert.strictEqual(out.toolCalls[0].result.ok, false);
    assert.match(out.toolCalls[0].result.error, /nicht angebunden/);
  });

  test('runs a wired tool and feeds the result back to the model', async () => {
    const products = [{ id: '1', handle: 'einhorn-set', title: 'Einhorn Set', price: '89.00' }];
    const { agent, fake } = agentWith([
      call('search_products', { query: 'Einhorn' }),
      text('Wir haben ein Einhorn Set. Wann ist die Party?'),
    ]);
    const out = await agent.reply({
      message: 'habt ihr Einhorn Sets?',
      services: { catalog: { search: async () => products } },
    });
    assert.strictEqual(out.toolCalls[0].result.ok, true);
    assert.strictEqual(out.toolCalls[0].result.count, 1);
    // The second model call must include the tool result.
    const second = fake.seen[1];
    const toolMsg = second.find((m) => m.role === 'tool');
    assert.ok(toolMsg, 'tool result should be in the next request');
    assert.match(toolMsg.content, /Einhorn Set/);
  });

  test('handoff_to_human flags the turn and notifies the owner', async () => {
    const notified = [];
    const { agent } = agentWith([
      call('handoff_to_human', { reason: 'damage', summary: 'Vorhang eingerissen' }),
      text('Das schaut sich jemand aus dem Team an, du hoerst von uns.'),
    ]);
    const out = await agent.reply({
      message: 'der Vorhang ist eingerissen, was kostet das?',
      services: { notify: { owner: async (t, m) => notified.push({ t, m }) } },
      chatId: '41790000000@s.whatsapp.net',
    });
    assert.ok(out.handoff);
    assert.strictEqual(notified.length, 1);
    assert.match(notified[0].t, /damage/);
    assert.match(notified[0].t, /Vorhang/);
  });

  test('a throwing tool is reported, not propagated', async () => {
    const { agent } = agentWith([
      call('search_products', { query: 'x' }),
      text('Das klappt gerade nicht, ich gebe das weiter.'),
    ]);
    const out = await agent.reply({
      message: 'suche',
      services: {
        catalog: {
          search: async () => {
            throw new Error('shop timeout');
          },
        },
      },
    });
    assert.strictEqual(out.toolCalls[0].result.ok, false);
    assert.match(out.toolCalls[0].result.error, /shop timeout/);
  });
});

describe('agent: limits and language', () => {
  test('stops at the step limit and hands over', async () => {
    const queue = Array.from({ length: 10 }, () => call('search_products', { query: 'x' }));
    const { agent } = agentWith(queue, { maxSteps: 3 });
    const out = await agent.reply({ message: 'hallo' });
    assert.ok(out.handoff);
    assert.strictEqual(out.toolCalls.length, 3);
  });

  test('retries a 500 from OpenAI', async () => {
    let calls = 0;
    const openai = {
      chat: {
        completions: {
          create: async () => {
            calls++;
            if (calls === 1) {
              const err = new Error('server error');
              err.status = 500;
              throw err;
            }
            return { choices: [{ message: text('Hoi!') }] };
          },
        },
      },
    };
    const agent = createAgent({ openai, knowledge, guards, config: { maxRetries: 2 } });
    const out = await agent.reply({ message: 'hallo' });
    assert.strictEqual(out.text, 'Hoi!');
    assert.strictEqual(calls, 2);
  });

  test('detects the customer language', () => {
    assert.strictEqual(resolveLanguage({ message: 'Hallo, ich suche Deko für einen Geburtstag' }).lang, 'de');
    assert.strictEqual(resolveLanguage({ message: 'Hi, how much is it to rent the unicorn set?' }).lang, 'en');
  });

  test('an English chat gets an English fallback when blocked', async () => {
    const { agent } = agentWith([text('Your booking is confirmed, see you!')]);
    // 'auto' = live behaviour: follow the customer (the default follows the dashboard switch for testing)
    const out = await agent.reply({ message: 'Can you confirm my booking for the unicorn set?', langSetting: 'auto' });
    assert.ok(out.blocked);
    assert.strictEqual(out.lang, 'en');
    assert.match(out.text, /colleague/);
  });
});
