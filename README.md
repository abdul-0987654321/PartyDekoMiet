# PartyDekoMiet — WhatsApp AI agent

WhatsApp assistant for [partydekomiet.ch](https://partydekomiet.ch), a party
decoration rental in Zürich. Answers customers 24/7 in German (or English),
shows matching sets from the Shopify shop, checks Google Calendar for the 3-day
rental window, and creates pending booking requests.

Built from the client's AGB — those rules are the source of truth and are
enforced in code, not only in the prompt.

## The rules it can never break

| Rule | Where it comes from |
|---|---|
| Self-pickup only, never delivery or setup | AGB §3 |
| 3 consecutive days rental | AGB §4 |
| CHF 50.– deposit, CHF 50.– per started late day | AGB §5, §8 |
| A booking is binding only after availability **and** payment | AGB §2 |
| Never invent repair prices — hand damage to a human | Teil 3 |
| Swiss orthography, no "ß" | the AGB itself |

The system prompt states these, and `src/agent/guards.js` enforces them on every
outgoing message. A prompt can be argued with; a regex cannot. If a reply breaks
a rule it is replaced with a neutral sentence, the chat is handed to a human and
the owner is notified.

## Architecture

```
WhatsApp (Baileys) ─► router ─► agent (OpenAI tool calling) ─► tools
      │                 │              │                        ├─ catalog   Shopify products.json + cache
      │                 │              │                        ├─ calendar  availability + [PENDING] events
      │            owner cmds     knowledge/                    ├─ bookings  record + owner notification
      │            takeover       (prompt, rules, FAQ)          └─ handoff   stop and fetch a human
      └─► Google Sheet: session · settings · customers · bookings · chat
```

Nothing about party decoration lives in `src/`. Everything business-specific is
in `knowledge/`, so a second bot is a new knowledge folder and a new `.env`.

## Quick start

```bash
npm install
cp .env.example .env     # fill in at least OPENAI_API_KEY
npm run chat -- --dry    # talk to it with a fake model, no key, no network
npm run chat             # talk to it with the real model
npm start                # full service: HTTP + WhatsApp
npm test                 # 111 tests
```

## Setup, in order

1. **[Google Sheet](docs/GOOGLE_SHEET_SETUP.md)** — storage. Render's disk is
   wiped on every deploy, so the WhatsApp session lives in the sheet; without it
   you rescan a QR code after every deploy. *(5 min)*
2. **OpenAI key** — `OPENAI_API_KEY` from platform.openai.com.
3. **Google Calendar** — availability. *(15 min)*
   Follow **[docs/CALENDAR_SIMPLE.md](docs/CALENDAR_SIMPLE.md)** — numbered clicks,
   nothing else. [The longer version](docs/GOOGLE_CALENDAR_SETUP.md) explains why
   each step exists.
4. **Deploy** — see below.
5. **Link WhatsApp** — dashboard → WhatsApp. Two ways, both offered:
   **QR code**, or **pairing code**: type the bot phone's number and enter the
   8-character code on the phone (Linked devices → Link a device → "Link with
   phone number instead"). The pairing code is the easier one when the phone and
   the screen are not in the same place.
6. Hand the client **[docs/CLIENT_GUIDE.md](docs/CLIENT_GUIDE.md)**.

## Configuration

Two places, on purpose:

- **Environment variables** — secrets and bootstrap values. `.env` locally,
  Render's Environment tab in production. See `.env.example`.
- **Dashboard → Settings** — everything operational: owner number, prices,
  deposit handling, pickup hours, rental window, buffer days, bot language,
  dashboard language. Saved in the Google Sheet, applied immediately, no deploy.

A dashboard value always wins over the environment variable, and each setting
shows where its current value came from. API keys are never dashboard-editable —
a key written into a Google Sheet stays in that sheet's revision history forever.

## Deployment (Render)

| Setting | Value |
|---|---|
| Build command | `npm ci` |
| Start command | `node src/index.js` |
| Health check path | `/health` |
| Region | Frankfurt |

`render.yaml` carries the non-secret values; set the secrets in the dashboard.

**On the free plan:** free instances sleep after 15 minutes idle and have no
persistent disk. The missing disk does not matter — everything lives in the
Google Sheet. The sleeping does, so point **UptimeRobot at `/health` every 5
minutes**. Note that Render's free instance hours are shared across your whole
account, so several always-on free services will not fit in a month. For a
client's live number, use the paid starter plan.

## Dashboard

| Page | |
|---|---|
| `/` | status: WhatsApp, storage, catalog, calendar, paused chats |
| `/test` | chat with the real bot without WhatsApp, with the tools it used shown |
| `/chats` | read conversations and reply by hand; replying pauses the bot there |
| `/whatsapp` | link the phone by QR **or** pairing code, and re-link |
| `/bookings` | all requests |
| `/settings` | everything configurable |

Protected by `DASHBOARD_PASSWORD`. `/health` is the only open endpoint and
carries nothing secret.

## Owner commands (WhatsApp)

`/status` · `/pause <number>` · `/resume <number>` · `/off` · `/on` · `/help`

The bot also pauses itself in a chat for 12 hours whenever the owner answers
there by hand, so it never talks over a human.

## Testing

```bash
npm test                  # unit tests
npm run chat -- --dry     # scripted fake model, no API key
npm run chat              # real model, in the terminal
```

Easier: open **/test** in the dashboard. It talks to the real agent with the real
catalog and calendar, shows which tools were called and flags a reply the guards
blocked, but never touches WhatsApp and never writes to the customer tables. It
is safe to use on the live deployment, and it is the surface to record for a demo.

For a demo recording, fill the dashboard with invented data first:

```bash
npm run seed:demo             # dry run
node tools/seed-demo.js --write
node tools/seed-demo.js --clear
```

It refuses to write into storage that already holds real data, because recording
the live dashboard would put customers' phone numbers and conversations on
screen.

## One number, two businesses

If the same WhatsApp number is also used for another business, set
**Settings → Bot → Keywords for other businesses**. A message containing one of
them is answered with a short honest note and handed to a human, without the
model ever seeing it. That check is deliberately not left to the prompt: a
question about the other business is not a rule violation, so no guard would
catch the bot answering it with the rental rules - confidently and wrongly.

Worth knowing about the test suite: it asserts that none of the 15 official FAQ
answers trips a guard. Several of them contain the exact words the guards look
for ("Lieferservice", "Buchung ist verbindlich", "Ersatzkosten"), so an
over-eager guard would silence the bot on ordinary questions.

## A second bot

`knowledge/` holds `business.json`, `faq.json`, `rules.md` and `persona.md`.
Copy the project, replace that folder, change `.env`. Set `KNOWLEDGE_SOURCE=sheet`
to let the owner edit FAQ and prices in the Google Sheet instead of files.

## Risk worth stating

This uses Baileys, an unofficial WhatsApp library, on a real business number.
WhatsApp can ban it. The code mitigates what it can — private chats only, never
initiates a conversation, human-like typing delays, a per-chat hourly cap — but
the risk is not zero, and the client should know that.
