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

describe('products written as a text list are sent as pictures', () => {
  const { createAgent } = require('../src/agent/agent');
  const { createGuards } = require('../src/agent/guards');
  const knowledge = require('../src/knowledge/from-files').load();
  const guards = createGuards({ faqAnswers: [], depositChf: 50, lateFeeChf: 50 });

  const PRODUCTS = [
    { id: 'kindergeburtstag-deko-dschungel', title: 'Junge-KinderGeburtstag Deko Dschungel safari Auto Set', price: 'CHF 250.–', url: 'https://partydekomiet.ch/products/kindergeburtstag-deko-dschungel' },
    { id: 'kindergeburtstag-einhorn', title: 'KinderGeburtstag Einhorn Deko', price: 'CHF 350.–', url: 'https://partydekomiet.ch/products/kindergeburtstag-einhorn' },
  ];

  // Exactly what the live bot answered on 15 Oct: a list of links, no pictures.
  const LISTED = [
    "Here are some decoration sets for your daughter's 10th birthday:",
    '',
    `• *${PRODUCTS[0].title}*: CHF 250.– View Set: ${PRODUCTS[0].url}`,
    `• *${PRODUCTS[1].title}*: CHF 350.– View Set: ${PRODUCTS[1].url}`,
    '',
    'Do any of these themes catch your interest?',
  ].join('\n');

  function run(queue, services) {
    const openai = { chat: { completions: { create: async () => ({ choices: [{ message: queue.shift() }] }) } } };
    const agent = createAgent({ openai, knowledge, guards, config: { maxRetries: 0 } });
    return agent.reply({ message: 'party for my daughter 10 years, 20 October', services, chatId: '41790000777@s.whatsapp.net', langSetting: 'auto' });
  }

  const searchCall = {
    role: 'assistant', content: null,
    tool_calls: [{ id: 'c1', type: 'function', function: { name: 'search_products', arguments: '{"query":"Geburtstag"}' } }],
  };

  beforeEach(async () => {
    await db.init(createMemoryBackend());
    settings.load();
  });

  test('the listed products go out as picture cards and leave the text', async () => {
    const cards = [];
    const services = {
      catalog: { search: async () => PRODUCTS, byId: async (id) => PRODUCTS.find((p) => p.id === id) },
      messenger: { sendProduct: async (jid, product) => cards.push(product.title) },
    };
    const out = await run([searchCall, { role: 'assistant', content: LISTED }], services);
    assert.deepStrictEqual(cards, [PRODUCTS[0].title, PRODUCTS[1].title]);
    assert.doesNotMatch(out.text, /https:\/\//, 'no wall of links left');
    assert.match(out.text, /catch your interest/, 'the question stays');
    assert.ok(out.toolCalls.some((c) => c.name === 'send_product' && c.result.auto));
  });

  test('nothing extra is sent when the model already used send_product', async () => {
    const cards = [];
    const services = {
      catalog: { search: async () => PRODUCTS, byId: async (id) => PRODUCTS.find((p) => p.id === id) },
      messenger: { sendProduct: async (jid, product) => cards.push(product.title) },
    };
    const sendCall = {
      role: 'assistant', content: null,
      tool_calls: [{ id: 'c2', type: 'function', function: { name: 'send_product', arguments: `{"product_id":"${PRODUCTS[0].id}"}` } }],
    };
    await run([searchCall, sendCall, { role: 'assistant', content: `Gefällt dir das? ${PRODUCTS[0].url}` }], services);
    assert.deepStrictEqual(cards, [PRODUCTS[0].title], 'only the one the model sent itself');
  });

  test('products never searched are never sent', async () => {
    const cards = [];
    const services = {
      catalog: { search: async () => [], byId: async () => PRODUCTS[0] },
      messenger: { sendProduct: async (jid, product) => cards.push(product.title) },
    };
    await run([{ role: 'assistant', content: LISTED }], services);
    assert.strictEqual(cards.length, 0);
  });

  test('the test page (no messenger) keeps the text as it is', async () => {
    const services = { catalog: { search: async () => PRODUCTS, byId: async (id) => PRODUCTS.find((p) => p.id === id) } };
    const out = await run([searchCall, { role: 'assistant', content: LISTED }], services);
    assert.match(out.text, /View Set/);
  });
});

describe('client answers of 15 Oct', () => {
  beforeEach(async () => {
    await db.init(createMemoryBackend());
    settings.load();
  });

  test('defaults: one buffer day, deposit separate, one copy per set', () => {
    assert.strictEqual(settings.get('bufferDays'), 1);
    assert.strictEqual(settings.get('depositMode'), 'separate');
    assert.strictEqual(settings.get('defaultStock'), 1);
  });

  test('one buffer day: a set returned Monday cannot go out again on Monday', () => {
    const fri = { id: 'e', summary: '[CONFIRMED] Einhorn', start: { date: FRI }, end: { date: '2026-10-22' }, // Fri..Tue incl. buffer (end exclusive)
      extendedProperties: { private: { productId: 'p1' } } };
    const opts = { events: [fri], productId: 'p1', closedWeekdays: 'sun', bufferDays: 1 };
    assert.strictEqual(checkWindow({ ...opts, pickup: MON }).available, false);
    assert.strictEqual(checkWindow({ ...opts, pickup: '2026-10-21' }).available, false, 'Tuesday is the buffer day');
    assert.strictEqual(checkWindow({ ...opts, pickup: '2026-10-22' }).available, true);
  });

  test('separate deposit without a shop item: honest sentence, no broken link', async () => {
    const { createBookings } = require('../src/bookings');
    assert.ok(createBookings);
    const src = require('fs').readFileSync(require('path').join(__dirname, '../src/bookings.js'), 'utf8');
    assert.match(src, /Wie du sie bezahlst, sagen wir dir mit der Bestaetigung/);
  });
});

describe('test of 15 Oct 18:02: "more options" repeated the same sets', () => {
  const { search } = require('../src/catalog/search');
  const { cleanTitle } = require('../src/catalog/shopify');
  const { runTool } = require('../src/agent/tools');
  const P = (handle, title, extra = {}) => ({
    id: handle, handle, title, tags: [], productType: '', description: '', available: true,
    url: `https://partydekomiet.ch/products/${handle}`, ...extra,
  });
  const CATALOG = [
    P('kindergeburtstag-einhorn', 'KinderGeburtstag  Einhorn deko  whats 0786353632 Zurich'),
    P('einhorn-rosa', 'Einhorn Set Rosa'),
    P('einhorn-blau', 'Einhorn Deko Blau Silber'),
    P('tischdecke-blue-blatter', 'Tischdecke Blue Blatter'),
    P('teddy', 'Teddy Party dekoration mit Montage inclusive', { description: 'blau und weiss' }),
  ];
  const JID = '41790000777@s.whatsapp.net';

  beforeEach(async () => {
    await db.init(createMemoryBackend());
    settings.load();
  });

  test('"Einhorn, blue": unicorn sets only, the blue one first, no tablecloth', () => {
    const hits = search(CATALOG, { query: 'Einhorn', color: 'blue' });
    assert.ok(hits.every((p) => /einhorn/i.test(p.title)), hits.map((p) => p.title).join(' | '));
    assert.strictEqual(hits[0].handle, 'einhorn-blau');
  });

  test('only a colour asked: colour matches are still found', () => {
    assert.ok(search(CATALOG, { query: 'blau' }).length > 0);
  });

  test('phone numbers are taken out of titles shown to customers', () => {
    assert.strictEqual(cleanTitle(CATALOG[0].title), 'KinderGeburtstag Einhorn deko');
  });

  test('"more": sets already sent in the chat are left out', async () => {
    const catalog = {
      search: async (args) => search(CATALOG, args).map((p) => ({ id: p.handle, title: p.title, url: p.url })),
    };
    // the first set was already sent as a card
    db.put('chat', { id: 'c1', at: new Date().toISOString(), jid: JID, direction: 'out',
      image: 'https://cdn/x.jpg', text: `*Einhorn*\nCHF 350\n${CATALOG[0].url}` });
    const res = await runTool('search_products', { query: 'Einhorn' }, { catalog, chatId: JID });
    assert.ok(!res.products.some((p) => p.url === CATALOG[0].url));
    assert.strictEqual(res.already_shown, 1);
  });

  test('nothing new left: say so instead of repeating', async () => {
    const catalog = { search: async () => [{ id: 'a', title: 'A', url: 'https://s/a' }] };
    db.put('chat', { id: 'c2', at: new Date().toISOString(), jid: JID, direction: 'out', image: 'i', text: 'x https://s/a' });
    const res = await runTool('search_products', { query: 'x' }, { catalog, chatId: JID });
    assert.strictEqual(res.count, 0);
    assert.match(res.note, /schon gezeigt/);
  });

  test('after the cards, the empty "Here are more options:" line is dropped', async () => {
    const { sendListedProducts } = require('../src/agent/agent');
    const products = [{ id: 'a', title: 'Einhorn Set Rosa', url: 'https://s/a' }];
    const text = 'Here are more options:\n\n- *Einhorn Set Rosa*: CHF 1 https://s/a\n\nLet me know if any of these catch your eye!';
    const out = await sendListedProducts(
      text,
      [{ name: 'search_products', result: { ok: true, products } }],
      { catalog: { byId: async () => products[0] }, messenger: { sendProduct: async () => {} } },
      JID
    );
    assert.strictEqual(out.text, 'Let me know if any of these catch your eye!');
  });
});

describe('test of 15 Oct 18:10: multi-line product list and hidden WhatsApp ids', () => {
  const { sendListedProducts } = require('../src/agent/agent');
  const contacts = require('../src/contacts');
  const JID = '150375495651422@lid';

  beforeEach(async () => {
    await db.init(createMemoryBackend());
    settings.load();
  });

  const U = (h) => `https://partydekomiet.ch/products/${h}`;
  const products = [
    { id: 'a', title: 'Geburtstagsdeko mieten in Zürich Deko Set', url: U('a') },
    { id: 'b', title: 'KinderGeburtstag deko set Dschu baby 2', url: U('b') },
    { id: 'c', title: 'KinderGeburtstag Deko Super Mario', url: U('c') },
    { id: 'd', title: 'Party dekoration- kindergeburtstag deko 1jahr- dschunglel party deko set beige weiss', url: U('party-deko-to-go-safari-weiss') },
    { id: 'e', title: 'KinderGeburtstag Dekoration Fr 350 Auktion Fr 270 Mause G sarn', url: U('fr-350-auktion-fr-270-mause-g-sarn') },
  ];
  // What the bot wrote live: numbered items over three lines each.
  const LIVE = [
    "Here are some decoration options for your son's 10th birthday party with blue accents:",
    '',
    ...products.flatMap((p, i) => [`${i + 1}. **${p.title}**`, '   CHF 150.–', `   Link zur Deko: ${p.url}`, '']),
    'The decoration is available for pickup tomorrow, October 16th, and you would return it on October 19th.',
    '',
    'Let me know which one you like!',
  ].join('\n');

  test('every listed set goes out as a card and no lone price lines stay behind', async () => {
    const cards = [];
    const out = await sendListedProducts(
      LIVE,
      [{ name: 'search_products', result: { ok: true, products } }],
      { catalog: { byId: async (id) => products.find((p) => p.id === id) }, messenger: { sendProduct: async (j, p) => cards.push(p.id) } },
      JID
    );
    assert.deepStrictEqual(cards, ['a', 'b', 'c', 'd', 'e']);
    assert.doesNotMatch(out.text, /CHF|https?:|\*\*/);
    assert.strictEqual(
      out.text,
      'The decoration is available for pickup tomorrow, October 16th, and you would return it on October 19th.\n\nLet me know which one you like!'
    );
  });

  test('the real phone number is kept for a hidden-id chat and shown instead of the id', () => {
    contacts.remember('party', { key: { remoteJid: JID, fromMe: false, remoteJidAlt: '41791234567@s.whatsapp.net' }, pushName: 'Anma' });
    assert.strictEqual(contacts.phoneOf('party', JID), '41791234567');
    assert.strictEqual(require('../src/customers').get('party', JID).pushName, 'Anma');
    const { m } = require('../src/notify/messages');
    assert.match(m().handoff(JID, 'x'), /41791234567/);
  });

  test('older Baileys field senderPn works too; unknown stays the id', () => {
    contacts.remember('party', { key: { remoteJid: '999@lid', fromMe: false, senderPn: '41765550000@s.whatsapp.net' } });
    assert.strictEqual(contacts.phoneOf('party', '999@lid'), '41765550000');
    assert.strictEqual(contacts.phoneOf('party', '888@lid'), '888');
  });
});

describe('official damage price list (15 Oct)', () => {
  const k = require('../src/knowledge/from-files').load();
  const { createGuards } = require('../src/agent/guards');
  const { buildSystemPrompt } = require('../src/agent/prompt');
  const guards = createGuards({ faqAnswers: k.faq.flatMap((e) => [e.a_de, e.a_en]), damagePrices: k.damagePrices });
  const codes = (t) => guards.check(t).map((v) => v.code);

  test('the list is loaded and in the prompt', () => {
    assert.match(k.damagePrices, /Grosse Glasvasen[^\n]*CHF 30/);
    assert.match(buildSystemPrompt(k), /Schadensliste \(offiziell/);
  });

  test('prices from the list may be quoted', () => {
    assert.deepStrictEqual(codes('Laut unserer Schadensliste kostet eine zerbrochene grosse Glasvase CHF 30.–.'), []);
    assert.deepStrictEqual(codes('A missing screw costs CHF 20 according to our damage list.'), []);
    assert.deepStrictEqual(codes('Für die Reinigung von Flecken rechnen wir CHF 5.– bis CHF 6.– pro Artikel.'), []);
  });

  test('any other amount next to a damage word is still blocked', () => {
    assert.deepStrictEqual(codes('Die Reparatur des Vorhangs kostet CHF 80.–.'), ['INVENTED_PRICE']);
    assert.deepStrictEqual(codes('Replacing the damaged panel costs CHF 120.'), ['INVENTED_PRICE']);
  });

  test('no list -> old behaviour: only deposit and late fee', () => {
    const plain = createGuards({ faqAnswers: [] });
    assert.deepStrictEqual(plain.check('Eine grosse Glasvase kostet bei Schaden CHF 30.–.').map((v) => v.code), ['INVENTED_PRICE']);
  });
});
