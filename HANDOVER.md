# PartyDekoMiet + Studio — WhatsApp bot

Paste this into a new Claude session to pick the work up.

---

## What this is

One Node app running **two WhatsApp businesses** for a Swiss client, plus a
number per professional.

- **PartyDekoMiet** — party decoration rental. Customers book sets from a
  Shopify shop.
- **Studio** — appointments with professionals (adult massage studio, legal in
  Switzerland).

It runs on **Render**, auto-deploying from branch
`claude/compassionate-darwin-yvck7r`. Data lives in a **Google Sheet** via an
Apps Script webhook (`apps-script/Code.gs`), which creates tabs by itself.

The client does not touch code. Everything he changes is in the **dashboard**.

**Repo:** https://github.com/abdul-0987654321/PartyDekoMiet

---

## How to talk to me (the owner)

- **Reply in English.** My dashboard is set to English, so use the English
  labels when you tell me where to click (Settings, Numbers, Professionals,
  Services, Appointments).
- I test live and send you the WhatsApp transcript when something is wrong.
  Read the transcript carefully — the bug is usually in it.
- **Don't ask me to approve a plan.** Find it, fix it, test it, push it, then
  tell me in plain words what was wrong.
- Don't over-guard. A bot that fetches a human at every unclear sentence is
  worse than no bot.

---

## The numbers

| Number | What it is |
|---|---|
| PartyDekoMiet | built in, rental side |
| Studio | built in, the whole studio |
| up to 5 more | one per professional (`pro-*`) |

**Limit is 7 total on the Numbers page**, PartyDekoMiet and Studio included.

Internally a number is called a **line**, and a line id *is* the `business`
value threaded through everything (`src/lines.js`). `party` keeps unprefixed
session keys — renaming them logs the phone out.

**What each number's dashboard shows:**

- **Studio** = everything. All appointments, whole calendar, all services, the
  team. This is where a service is created or moved between people.
- **A professional's number** = only hers. Her appointments, her calendar, her
  chats, and the services she can be booked for (her own + studio-wide). Her
  Status page opens with who she is: name, location, hours, her WhatsApp
  number, busy/free.
- "Hers" means **who the appointment is for**, not which number took it. Booked
  on the Studio's main number for her → still on her page.

---

## Alerts — the rule

**Alerts go to the phone the number is connected on. Nothing to configure.**

Whoever scans the QR for a number gets that number's alerts, in that phone's
own "Message yourself" chat. There is no alert-number field anywhere any more —
there used to be five (three typed in, two invisible) and every alert confusion
for a month came out of that ladder.

Settings → **Where alerts go** names the number. Every alert ends with
`[Studio]` / `[PartyDekoMiet]` / `[TST]` so three numbers don't produce three
identical-looking messages.

`ownerWhatsapp` / `studioOwnerWhatsapp` still exist, hidden, for recognising
the owner's commands. They no longer decide where alerts go.

---

## A professional's own number

If a professional has her own connected line, **she talks to the bot in that
same chat** (messages from her phone are `fromMe` in the self-chat):

- **J / N** (or Y / N) — confirm or decline a request
- **"besetzt" / "frei"** — busy or free, by text or voice note
- **"der Kunde bleibt noch eine halbe Stunde"** — extends the running
  appointment and the calendar entry

The request alert on her own line ends with "reply J to confirm". **No second
message** is sent to the number on her profile — she already has it.

The profile WhatsApp number is only for when the booking comes in on the
**Studio's main number**: that alert goes to the owner, so she is messaged
separately. Clear the number and those messages stop.

---

## Hard rules the bot must never break

Enforced in code (`src/agent/guards.js`, `src/agent/guards-studio.js`), not
just in the prompt — a prompt can be talked around, a regex cannot.

1. **Never ask for payment, never send a payment link.** The team invoices.
2. **Never say an appointment or booking is confirmed** until a person presses
   Confirm. And never "confirmed once paid".
3. **Never speak as the professional** ("I'm 24 and from Brazil") — the bot is
   the receptionist.
4. **Nothing beyond the price list** — but the price list is *whatever the
   owner typed into Services*, read fresh every reply. If his service
   description says what it includes, the bot may say it. If it's in no active
   service, the bot is inventing an offer and it's blocked.
5. **Never put unprotected sex in writing**, whatever the service list says.
   Blocked outright; the owner is alerted and a person answers.
6. **Never quote a price** that isn't an active service's own price.
7. **Never tell the customer about the machinery** — "it seems there was a
   mix-up", "I apologize for the confusion" are stripped out of the reply; the
   real answer underneath survives.
8. **Handoff only for**: complaint, cancellation, change to an existing
   booking/appointment, price dispute, something not offered. **Never because a
   message was vague or misspelled** — ask instead. Enforced in the tool: a
   vague reason is refused.
9. **Ask the name and the date every time**, even for a returning customer —
   but once per conversation, not once per message.
10. **The customer's time is the time.** Never argue twice about it.

---

## Things that bit us (don't reintroduce)

- **LID chats.** WhatsApp addresses most people by a hidden id
  (`1503754…@lid`), not a phone number. **Never rebuild a jid from a number** —
  reply into the chat jid you already have (`notify.toChat`). Confirmations
  went nowhere for months because of this.
- **Appointments past midnight.** 23:30 + 1h is 00:30 *the next day*, not
  "24:30". Found from either side of midnight.
- **A claim or a promise with no tool call.** "I'll pass your request to the
  team" is the same as "I have" — the model is nudged to actually call the
  tool, then the sentence is stripped. `REQUEST_TOOLS` must list the real tool
  names.
- **Settings that are hidden but still read.** A saved dashboard value silently
  beating Render, with no way to see or clear it. Twice.
- **Biz-aware endpoints.** Any endpoint reading `biz` must be in
  `BIZ_AWARE_PREFIXES` in `public/app.js`, or the Studio dashboard silently
  shows PartyDekoMiet's data. There's a test that catches this.
- **Clock-dependent tests.** Never pair "20 minutes ago" with "today" — they
  are different days at 00:01. Pin the clock.
- **Lookups that only read a title.** A service named "Sofia" whose
  description says "Wellness Massage" must be findable by "massage".

---

## Layout

```
src/
  index.js                 boot: wires every line, agent, calendar, notifier
  lines.js                 the numbers; MAX_LINES = 7
  whatsapp/router.js       message routing (owner / professional / customer)
  whatsapp/client.js       Baileys
  agent/agent.js           OpenAI tool-calling loop
  agent/tools/index.js     PartyDekoMiet tools
  agent/tools/studio.js    Studio tools
  agent/guards.js          hard rules + strip rules (shared)
  agent/guards-studio.js   Studio rules
  agent/handoff.js         what counts as a real handoff
  bookings.js              rentals
  appointments.js          studio appointments
  studio/directory.js      professionals, services, locations
  studio/professional-*.js her busy/free, her J/N replies
  calendar/local-client.js built-in calendar (Google is gone)
  notify/owner.js          alerts; toChat / toNumber
  http/server.js           dashboard API
public/                    the dashboard (plain HTML + app.js)
knowledge/, knowledge-studio/   prompt rules per business
test/                      874 tests, node:test
docs/handbuch.html         the client's manual (German)
```

---

## Working on it

```bash
npm test          # 874 tests, all must pass
```

**Before pushing:** run the suite, and check every new test actually bites —
break the fix and confirm the test goes red. Several tests in here were written
against behaviour that was already wrong.

A browser check exists for dashboard changes (puppeteer, laptop 1280×900 and
phone 390×844, detects overflow / overlapping text / JS errors). Rebuild it if
you need it; the old scripts were in `/tmp`.

Commit messages: say what was broken, what the person experienced, and why the
fix is right. Not a changelog.

---

## Still open

- **Multi-language** — never quoted, never started.
- The client should **rename the service "Sofia"** to something like "Wellness
  Massage 60 Min". A service named after a person who isn't the professional
  keeps causing confusion in the chat and on the Services page.
