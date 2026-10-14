'use strict';
/**
 * Three client requests from 13-15 Oct:
 *  - "pickup Friday -> bring it back Monday, I don't work on Sunday"
 *  - voice notes: customers' are transcribed; the owner dictates replies in his
 *    language and names the language the customer should get
 *  - the dashboard DE/EN switch decides the bot's language while testing
 */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');
const db = require('../src/store/db');
const { createMemoryBackend } = require('../src/store/backend-memory');
const settings = require('../src/settings');
const { createRouter, numberIn, quotedTextOf } = require('../src/whatsapp/router');
const { rentalWindow, parseWeekdays, weekdayOf } = require('../src/calendar/dates');
const { checkWindow, findNextFree } = require('../src/calendar/availability');
const { createVoice, swiss } = require('../src/voice');

// 2026-10-16 is a Friday.
const FRI = '2026-10-16';
const SAT = '2026-10-17';
const SUN = '2026-10-18';
const MON = '2026-10-19';

describe('closed weekdays', () => {
  test('parses German, English and numbers, ignores junk', () => {
    assert.deepStrictEqual(parseWeekdays('sun'), [0]);
    assert.deepStrictEqual(parseWeekdays('So, Mo'), [0, 1]);
    assert.deepStrictEqual(parseWeekdays('Sonntag'), [0]);
    assert.deepStrictEqual(parseWeekdays('0'), [0]);
    assert.deepStrictEqual(parseWeekdays('blah, sunday'), [0]);
    assert.deepStrictEqual(parseWeekdays(''), []);
  });

  test('all seven closed is treated as a mistake, not as "never bookable"', () => {
    assert.deepStrictEqual(parseWeekdays('mo,di,mi,do,fr,sa,so'), []);
  });

  test('the fixture dates are the weekdays they claim to be', () => {
    assert.strictEqual(weekdayOf(FRI), 5);
    assert.strictEqual(weekdayOf(SUN), 0);
  });

  test('pickup Friday returns Monday when Sunday is closed', () => {
    const win = rentalWindow(FRI, { returnDayOffset: 2, closedWeekdays: 'sun' });
    assert.strictEqual(win.return, MON);
    assert.strictEqual(win.blockEnd, MON, 'the set stays blocked until it is back');
  });

  test('without closed days nothing changes (Friday -> Sunday)', () => {
    assert.strictEqual(rentalWindow(FRI, { returnDayOffset: 2 }).return, SUN);
  });

  test('other pickup days keep three days (Monday -> Wednesday)', () => {
    assert.strictEqual(rentalWindow(MON, { returnDayOffset: 2, closedWeekdays: 'sun' }).return, '2026-10-21');
  });

  test('Saturday pickup returns Monday', () => {
    assert.strictEqual(rentalWindow(SAT, { returnDayOffset: 2, closedWeekdays: 'sun' }).return, MON);
  });

  test('no pickup on a closed day', () => {
    const res = checkWindow({ events: [], productId: 'p1', pickup: SUN, closedWeekdays: 'sun' });
    assert.strictEqual(res.available, false);
    assert.strictEqual(res.reason, 'closed_day');
  });

  test('suggested free dates skip the closed day', () => {
    const free = findNextFree({ events: [], productId: 'p1', from: SAT, count: 2, closedWeekdays: 'sun' });
    assert.deepStrictEqual(free, [SAT, MON]);
  });

  test('a booking that runs over Sunday blocks Monday too', () => {
    const fridayBooking = {
      id: 'e1',
      summary: '[PENDING] Einhorn – Anna',
      start: { date: FRI },
      end: { date: '2026-10-20' }, // exclusive: Fri..Mon
      extendedProperties: { private: { productId: 'p1' } },
    };
    const res = checkWindow({ events: [fridayBooking], productId: 'p1', pickup: MON, closedWeekdays: 'sun' });
    assert.strictEqual(res.available, false);
  });

  test('the setting exists and defaults to Sunday', async () => {
    await db.init(createMemoryBackend());
    settings.load();
    assert.strictEqual(settings.get('closedWeekdays'), 'sun');
  });
});

describe('voice module', () => {
  const fakeOpenai = (transcript, composedJson) => ({
    audio: { transcriptions: { create: async () => ({ text: transcript }) } },
    chat: { completions: { create: async () => ({ choices: [{ message: { content: composedJson } }] }) } },
  });
  const toFile = async (buf, name, opts) => ({ buf, name, opts });

  test('transcribes a voice note', async () => {
    const v = createVoice({ openai: fakeOpenai('Habt ihr Einhorn Deko?', '{}'), toFile });
    assert.strictEqual(await v.transcribe(Buffer.from('x'), 'audio/ogg; codecs=opus'), 'Habt ihr Einhorn Deko?');
  });

  test('an empty transcript is an error, not an empty question', async () => {
    const v = createVoice({ openai: fakeOpenai('  ', '{}'), toFile });
    await assert.rejects(() => v.transcribe(Buffer.from('x')));
  });

  test('composes the owner reply in the language he asked for, Swiss spelling', async () => {
    const v = createVoice({
      openai: fakeOpenai('', JSON.stringify({ language: 'it', message: 'Ciao! Il set è libero sabato.' })),
      toFile,
    });
    const out = await v.composeOwnerReply('sag ihm das Set ist am Samstag frei, auf Italienisch');
    assert.strictEqual(out.language, 'it');
    assert.strictEqual(out.languageName, 'Italiano');
    assert.match(out.message, /libero/);
    assert.strictEqual(swiss('Strasse ß'), 'Strasse ss');
  });
});

describe('router: voice notes', () => {
  const OWNER = '41791111111';
  const OWNER_JID = `${OWNER}@s.whatsapp.net`;
  const CUSTOMER = '41790000777';
  const CUSTOMER_JID = `${CUSTOMER}@s.whatsapp.net`;
  const BOT_ME = '41785555555:7@s.whatsapp.net';

  let sent, alerts, agentCalls, voiceCalls;
  const client = {
    sendText: async (jid, text) => sent.push({ jid, text }),
    downloadMedia: async () => Buffer.from('audio'),
    getStatus: () => ({ status: 'connected', me: { id: BOT_ME, lid: null } }),
  };
  const notify = { owner: async (text, meta) => alerts.push({ text, meta }) };
  const agent = {
    reply: async (args) => {
      agentCalls.push(args);
      return { text: 'Antwort', toolCalls: [], handoff: false, blocked: false };
    },
  };
  const voice = {
    transcribe: async () => voiceCalls.transcript,
    composeOwnerReply: async (instruction, ctx) => {
      voiceCalls.composed.push({ instruction, ctx });
      return { language: 'it', languageName: 'Italiano', message: 'Ciao, il set è libero sabato.' };
    },
  };

  const audio = (from, { fromMe = false, quoted = null } = {}) => ({
    key: { remoteJid: from, fromMe, id: 'a' + Math.random() },
    message: {
      audioMessage: {
        mimetype: 'audio/ogg; codecs=opus',
        ...(quoted ? { contextInfo: { quotedMessage: { conversation: quoted } } } : {}),
      },
    },
  });
  const textMsg = (from, text, { fromMe = false, quoted = null } = {}) => ({
    key: { remoteJid: from, fromMe, id: 't' + Math.random() },
    message: quoted
      ? { extendedTextMessage: { text, contextInfo: { quotedMessage: { conversation: quoted } } } }
      : { conversation: text },
  });

  const makeRouter = (opts = {}) => {
    const r = createRouter({ client, agent, services: {}, notify, voice: 'voice' in opts ? opts.voice : voice });
    r.init();
    return r;
  };

  const ALERT = `\u{1F514} Uebergabe noetig im Chat mit ${CUSTOMER}\nLetzte Nachricht: Ist das Set frei?`;

  beforeEach(async () => {
    await db.init(createMemoryBackend());
    settings.load();
    await settings.update({ ownerWhatsapp: OWNER, botEnabled: true, dashboardLanguage: 'de' });
    sent = [];
    alerts = [];
    agentCalls = [];
    voiceCalls = { transcript: 'Habt ihr Einhorn Deko?', composed: [] };
  });

  test('helpers: number and quoted text', () => {
    assert.deepStrictEqual(numberIn('Chat: 41790000777').number, '41790000777');
    assert.strictEqual(numberIn('+41 79 000 07 77 sag ihm').number, '41790000777');
    assert.strictEqual(numberIn('CHF 50 am 2026-10-17'), null, 'prices and dates are not phone numbers');
    assert.strictEqual(quotedTextOf(textMsg(OWNER_JID, 'x', { quoted: 'hello' })), 'hello');
  });

  test('a customer voice note is transcribed and answered like text', async () => {
    await makeRouter().handle(audio(CUSTOMER_JID));
    assert.strictEqual(agentCalls.length, 1);
    assert.match(agentCalls[0].message, /^\u{1F3A4} Habt ihr Einhorn Deko\?/u);
    assert.deepStrictEqual(sent, [{ jid: CUSTOMER_JID, text: 'Antwort' }]);
    const saved = db.all('chat').find((c) => c.direction === 'in');
    assert.match(saved.text, /Einhorn/, 'the dashboard shows what was said');
  });

  test('an unreadable customer voice note: honest reply, owner told, no model call', async () => {
    voiceCalls.transcript = '';
    const failing = { ...voice, transcribe: async () => { throw new Error('bad audio'); } };
    await makeRouter({ voice: failing }).handle(audio(CUSTOMER_JID));
    assert.strictEqual(agentCalls.length, 0);
    assert.strictEqual(sent.length, 1);
    assert.match(sent[0].text, /schreib mir bitte/);
    assert.strictEqual(alerts[0].meta.kind, 'voice_failed');
  });

  test('owner voice reply to an alert -> preview to the owner, nothing to the customer yet', async () => {
    voiceCalls.transcript = 'Sag ihm, das Set ist am Samstag frei, auf Italienisch';
    await makeRouter().handle(audio(OWNER_JID, { quoted: ALERT }));
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].jid, OWNER_JID, 'the preview goes to the owner');
    assert.match(sent[0].text, /VORSCHAU an 41790000777 \(Italiano\)/);
    assert.match(sent[0].text, /il set è libero/);
    assert.strictEqual(agentCalls.length, 0, 'the sales bot is not involved');
  });

  test('"ok" sends it to the customer and pauses the bot in that chat', async () => {
    voiceCalls.transcript = 'Sag ihm, das Set ist frei, auf Italienisch';
    const r = makeRouter();
    await r.handle(audio(OWNER_JID, { quoted: ALERT }));
    await r.handle(textMsg(OWNER_JID, 'ok'));
    assert.deepStrictEqual(sent[1], { jid: CUSTOMER_JID, text: 'Ciao, il set è libero sabato.' });
    assert.match(sent[2].text, /Gesendet an 41790000777/);
    assert.ok(r.isPaused(CUSTOMER_JID), 'the bot must not talk over the owner');
    assert.ok(db.all('chat').some((c) => c.jid === CUSTOMER_JID && c.direction === 'out'));
  });

  test('"nein" discards it', async () => {
    const r = makeRouter();
    await r.handle(audio(OWNER_JID, { quoted: ALERT }));
    await r.handle(textMsg(OWNER_JID, 'nein'));
    assert.ok(!sent.some((s) => s.jid === CUSTOMER_JID));
    assert.match(sent[1].text, /Verworfen/);
  });

  test('a typed reply quoting an alert works the same way', async () => {
    await makeRouter().handle(textMsg(OWNER_JID, 'Sag ihr, gerne, auf Spanisch', { quoted: ALERT }));
    assert.strictEqual(voiceCalls.composed[0].instruction, 'Sag ihr, gerne, auf Spanisch');
    assert.match(sent[0].text, /VORSCHAU/);
  });

  test('the owner can say the number instead of quoting', async () => {
    voiceCalls.transcript = '41 79 000 07 77 das Set ist frei, auf Italienisch';
    await makeRouter().handle(audio(OWNER_JID));
    assert.match(sent[0].text, /VORSCHAU an 41790000777/);
    assert.doesNotMatch(voiceCalls.composed[0].instruction, /41 79/, 'the number is not part of the message');
  });

  test('no customer found -> ask, never guess', async () => {
    voiceCalls.transcript = 'Das Set ist frei';
    await makeRouter().handle(audio(OWNER_JID));
    assert.strictEqual(sent.length, 1);
    assert.match(sent[0].text, /An wen soll das gehen/);
  });

  test('preview off -> sent at once', async () => {
    await settings.update({ ownerVoicePreview: false });
    await makeRouter().handle(audio(OWNER_JID, { quoted: ALERT }));
    assert.strictEqual(sent[0].jid, CUSTOMER_JID);
  });

  test('works in the bot\'s own chat when the bot runs on the owner\'s number', async () => {
    const SELF = '41785555555@s.whatsapp.net';
    const r = makeRouter();
    await r.handle(audio(SELF, { fromMe: true, quoted: ALERT }));
    assert.strictEqual(sent[0].jid, SELF);
    assert.match(sent[0].text, /VORSCHAU/);
    await r.handle(textMsg(SELF, 'ok', { fromMe: true }));
    assert.strictEqual(sent[1].jid, CUSTOMER_JID);
    assert.ok(!r.isPaused(SELF), 'its own chat is never paused');
  });

  test('ordinary owner text without a quote is left alone', async () => {
    await makeRouter().handle(textMsg(OWNER_JID, 'Hallo'));
    assert.strictEqual(sent.length, 0);
  });

  test('without an OpenAI key the owner is told why', async () => {
    await makeRouter({ voice: null }).handle(audio(OWNER_JID, { quoted: ALERT }));
    assert.match(sent[0].text, /OpenAI/);
  });
});

describe('bot language follows the dashboard switch', () => {
  const { createAgent } = require('../src/agent/agent');
  const { createGuards } = require('../src/agent/guards');
  const knowledge = require('../src/knowledge/from-files').load();
  const guards = createGuards({ faqAnswers: [], depositChf: 50, lateFeeChf: 50 });
  const agent = createAgent({
    openai: { chat: { completions: { create: async () => ({ choices: [{ message: { role: 'assistant', content: 'Hi!' } }] }) } } },
    knowledge,
    guards,
    config: { maxRetries: 0 },
  });

  beforeEach(async () => {
    await db.init(createMemoryBackend());
    settings.load();
  });

  test('defaults to following the dashboard while testing', () => {
    assert.strictEqual(settings.get('botLanguage'), 'dashboard');
  });

  test('dashboard on EN -> bot answers English, even to German', async () => {
    await settings.update({ dashboardLanguage: 'en' });
    const out = await agent.reply({ message: 'Hallo, habt ihr Einhorn Deko für den Geburtstag?' });
    assert.strictEqual(out.lang, 'en');
  });

  test('dashboard on DE -> bot answers German, even to English', async () => {
    await settings.update({ dashboardLanguage: 'de' });
    const out = await agent.reply({ message: 'Hi, how much is it to rent the unicorn set?' });
    assert.strictEqual(out.lang, 'de');
  });

  test('"auto" for live use follows the customer again', async () => {
    await settings.update({ botLanguage: 'auto', dashboardLanguage: 'de' });
    const out = await agent.reply({ message: 'Hi, how much is it to rent the unicorn set?' });
    assert.strictEqual(out.lang, 'en');
  });
});

describe('product pictures', () => {
  const { createMessenger } = require('../src/whatsapp/messenger');
  const product = { title: 'Einhorn Set', priceLabel: 'CHF 89.-', url: 'https://shop/p/einhorn', image: '//cdn.shop/einhorn.jpg' };

  beforeEach(async () => {
    await db.init(createMemoryBackend());
    settings.load();
  });

  test('a sent product shows up in the dashboard chat, with its picture', async () => {
    const sent = [];
    const client = { sendImage: async (jid, url, caption) => sent.push({ url, caption }) };
    await createMessenger({ client }).sendProduct('41790000777@s.whatsapp.net', product);
    assert.strictEqual(sent[0].url, 'https://cdn.shop/einhorn.jpg', 'protocol-relative URLs are fixed');
    const row = db.all('chat')[0];
    assert.strictEqual(row.image, 'https://cdn.shop/einhorn.jpg');
    assert.match(row.text, /Einhorn Set/);
  });

  test('when WhatsApp cannot fetch the URL, the picture is downloaded and sent as a file', async () => {
    const forwarded = [];
    const client = {
      sendImage: async () => { throw new Error('media upload failed'); },
      forwardImage: async (jid, buffer, caption, type) => forwarded.push({ size: buffer.length, type }),
      sendText: async () => { throw new Error('should not fall back to text'); },
    };
    const fetchImpl = async () => ({
      ok: true,
      headers: { get: () => 'image/jpeg' },
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    });
    const out = await createMessenger({ client, fetchImpl }).sendProduct('41790000777@s.whatsapp.net', product);
    assert.ok(out.withImage);
    assert.deepStrictEqual(forwarded, [{ size: 3, type: 'image/jpeg' }]);
  });

  test('if the picture is truly unavailable, the text and link still go out', async () => {
    const texts = [];
    const client = {
      sendImage: async () => { throw new Error('x'); },
      forwardImage: async () => { throw new Error('x'); },
      sendText: async (jid, text) => texts.push(text),
    };
    const fetchImpl = async () => ({ ok: false, status: 404, headers: { get: () => '' } });
    const out = await createMessenger({ client, fetchImpl }).sendProduct('41790000777@s.whatsapp.net', product);
    assert.strictEqual(out.withImage, false);
    assert.match(texts[0], /https:\/\/shop\/p\/einhorn/);
  });
});
