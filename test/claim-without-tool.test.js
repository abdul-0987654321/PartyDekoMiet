'use strict';
/**
 * "Your request is with the team" when nothing was sent to the team.
 *
 * This is the failure worth catching: the customer stops worrying, the owner
 * never hears of it, and the day of the party is when everyone finds out.
 *
 * It is also the guard that has been hardest to get right, and the two wrong
 * versions are both in here as tests. The first fired on "I'll send your
 * request now" - an announcement, with the tool call coming on the next turn
 * once the customer agrees - and tore down conversations one message from a
 * booking. The second replaced the message with a handoff, which turned a
 * finished conversation into work for a person.
 *
 * What it does now is tell the model, once, that it forgot, and let it finish
 * the job. Only if it says the same thing again is the claim removed.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { createAgent } = require('../src/agent/agent');
const { createGuards } = require('../src/agent/guards');

const knowledge = require('../src/knowledge/from-files').load();
const guards = createGuards({ depositChf: 50, lateFeeChf: 50 });

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

function agentWith(queue) {
  const fake = fakeModel(queue);
  return { fake, agent: createAgent({ openai: fake.client, knowledge, guards, config: { maxRetries: 0 } }) };
}

const bookings = {
  create: async () => ({ ok: true, booking_id: 'B1', status: 'PENDING' }),
};

describe('a claim with nothing behind it', () => {
  test('is sent back to the model, which then makes the booking', async () => {
    const { agent, fake } = agentWith([
      text('Ich habe die Anfrage ans Team weitergegeben.'),
      call('create_booking_request', { product_id: 'p1', start_date: '2026-12-10', customer_name: 'Ana' }),
      text('Alles klar, das Team meldet sich bei dir.'),
    ]);

    const out = await agent.reply({ message: 'ok', services: { bookings }, chatId: 'x@s.whatsapp.net' });

    assert.ok(out.toolCalls.some((c) => c.name === 'create_booking_request'), 'the booking has to actually happen');
    assert.strictEqual(out.handoff, false, 'nobody needs to be pulled in for this');
  });

  test('the nudge tells the model exactly what it forgot', async () => {
    const { agent, fake } = agentWith([
      text('Ich habe die Anfrage ans Team weitergegeben.'),
      call('create_booking_request', { product_id: 'p1', start_date: '2026-12-10', customer_name: 'Ana' }),
      text('Erledigt.'),
    ]);
    await agent.reply({ message: 'ok', services: { bookings }, chatId: 'x@s.whatsapp.net' });

    const nudge = fake.seen.at(-1).find((m) => m.role === 'system' && /did not call create_booking_request/.test(m.content));
    assert.ok(nudge, 'the model is told which tool is missing');
  });

  test('if it asks for the missing detail instead, that is fine too', async () => {
    const { agent } = agentWith([
      text('Deine Anfrage ist beim Team.'),
      text('Auf welchen Namen soll die Anfrage laufen?'),
    ]);

    const out = await agent.reply({ message: 'ok', services: { bookings }, chatId: 'x@s.whatsapp.net' });
    assert.match(out.text, /Namen/);
    assert.strictEqual(out.handoff, false);
  });

  test('a claim repeated after the nudge is removed, not sent', async () => {
    const { agent } = agentWith([
      text('Deine Anfrage ist beim Team.'),
      text('Deine Anfrage ist beim Team. Das Set ist fuer deine Daten frei.'),
    ]);

    const out = await agent.reply({ message: 'ok', services: { bookings }, chatId: 'x@s.whatsapp.net' });
    assert.ok(!/beim Team/.test(out.text), out.text);
    assert.match(out.text, /frei/, 'the true half of the message survives');
  });
});

describe('what must not trigger it', () => {
  test('announcing what it is about to do', async () => {
    const { agent, fake } = agentWith([text('Ich gebe deine Anfrage jetzt ans Team weiter.')]);
    const out = await agent.reply({ message: 'ok', services: { bookings }, chatId: 'x@s.whatsapp.net' });

    assert.strictEqual(out.text, 'Ich gebe deine Anfrage jetzt ans Team weiter.');
    assert.strictEqual(fake.seen.length, 1, 'no second call to the model');
  });

  test('a claim that is true because the tool ran', async () => {
    const { agent } = agentWith([
      call('create_booking_request', { product_id: 'p1', start_date: '2026-12-10', customer_name: 'Ana' }),
      text('Ich habe die Anfrage ans Team weitergegeben.'),
    ]);
    const out = await agent.reply({ message: 'ok', services: { bookings }, chatId: 'x@s.whatsapp.net' });

    assert.strictEqual(out.text, 'Ich habe die Anfrage ans Team weitergegeben.');
  });

  test('an ordinary answer', async () => {
    const { agent, fake } = agentWith([text('Das Einhorn Set kostet CHF 250.- plus CHF 50.- Kaution.')]);
    const out = await agent.reply({ message: 'was kostet das?', services: { bookings } });

    assert.match(out.text, /250/);
    assert.strictEqual(fake.seen.length, 1);
  });
});
