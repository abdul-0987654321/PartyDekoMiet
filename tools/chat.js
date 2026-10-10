#!/usr/bin/env node
'use strict';
/**
 * Local test mode: talk to the agent from the terminal, without WhatsApp.
 *
 *   npm run chat                  real OpenAI, needs OPENAI_API_KEY
 *   npm run chat -- --dry         scripted fake model, no API key, no network
 *
 * Useful for checking tone and the FAQ answers with the client before any
 * WhatsApp number or Google account is involved.
 *
 * Commands inside the chat:  /reset   /history   /quit
 */

const readline = require('readline');
const { config } = require('../src/config');
const knowledgeLoader = require('../src/knowledge');
const { createGuards } = require('../src/agent/guards');
const { createAgent } = require('../src/agent/agent');

const DRY = process.argv.includes('--dry');

/** Stand-in for OpenAI so the loop can be exercised without a key or network. */
function fakeOpenAI() {
  return {
    chat: {
      completions: {
        create: async ({ messages }) => {
          const last = [...messages].reverse().find((m) => m.role === 'user');
          return {
            choices: [
              {
                message: {
                  role: 'assistant',
                  content:
                    `[dry run] Ich habe ${messages.length} Nachrichten im Kontext. ` +
                    `Du hast geschrieben: "${String(last?.content || '').slice(0, 80)}"`,
                },
              },
            ],
          };
        },
      },
    },
  };
}

async function main() {
  const knowledge = await knowledgeLoader.load({ source: config.knowledge.source });
  const guards = createGuards({
    faqAnswers: knowledge.faq.flatMap((e) => [e.a_de, e.a_en]),
    depositChf: config.business.depositChf,
    lateFeeChf: config.business.lateFeeChf,
  });

  let openai;
  if (DRY) {
    openai = fakeOpenAI();
  } else {
    require('../src/config').require(['openai']);
    const OpenAI = require('openai');
    openai = new OpenAI({ apiKey: config.openai.apiKey });
  }

  const agent = createAgent({ openai, knowledge, guards, config: config.openai });

  console.log('');
  console.log(`PartyDekoMiet - local test chat${DRY ? ' (dry run, fake model)' : ` (${config.openai.model})`}`);
  console.log('Catalog and calendar are not wired yet, so those tools report themselves unavailable.');
  console.log('Commands: /reset  /history  /quit');
  console.log('');

  const history = [];
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'Kunde > ' });
  rl.prompt();

  // Lines are handled one at a time: readline is paused while the agent thinks, so
  // piped input (echo ... | npm run chat) is processed in order instead of racing.
  let pending = Promise.resolve();

  rl.on('line', (line) => {
    rl.pause();
    pending = pending.then(() => handleLine(line)).then(
      () => {
        rl.resume();
        rl.prompt();
      },
      (err) => {
        console.error(`\n[error] ${err.message}\n`);
        rl.resume();
        rl.prompt();
      }
    );
  });

  async function handleLine(line) {
    const text = line.trim();
    if (!text) return;

    if (text === '/quit' || text === '/exit') return rl.close();
    if (text === '/reset') {
      history.length = 0;
      console.log('(history cleared)\n');
      return;
    }
    if (text === '/history') {
      console.log(JSON.stringify(history, null, 2), '\n');
      return;
    }

    try {
      const out = await agent.reply({ history: [...history], message: text, chatId: 'cli' });
      history.push({ role: 'user', content: text }, { role: 'assistant', content: out.text });

      console.log('');
      console.log(`Bot   > ${out.text}`);
      for (const c of out.toolCalls) {
        console.log(`        · tool ${c.name}(${JSON.stringify(c.args)}) -> ${JSON.stringify(c.result).slice(0, 160)}`);
      }
      if (out.blocked) {
        console.log(`        !! GUARD BLOCKED: ${out.violations.map((v) => v.code).join(', ')}`);
        for (const v of out.violations) console.log(`           "${v.sentence}"`);
      }
      if (out.handoff) console.log('        >> would hand over to a human + notify the owner');
      console.log('');
    } catch (err) {
      console.error(`\n[error] ${err.message}\n`);
    }
  }

  rl.on('close', async () => {
    await pending; // never cut a reply off half-way, e.g. when input is piped
    console.log('\nBye.');
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
