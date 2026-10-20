# Handoff — PartyDekoMiet WhatsApp AI agent

Everything a new session (or a new developer) needs to continue without asking.
Read this first, then `README.md`.

Last updated 2026-10-20. Added: the Studio bot's data layer - shared DB tagged
by business, professionals/services/locations directory, Studio settings group,
time-slot availability, Studio guards, Studio knowledge folder. The Studio bot
does **not** reply on WhatsApp yet - see "Studio: what's built vs what's left"
below before doing anything else on it.

---

## 1. What this is

A WhatsApp assistant for **partydekomiet.ch**, a party decoration rental in
Zürich run by **Simone Frei**. Customers write on WhatsApp; the bot answers in
German or English, shows sets from the Shopify shop, checks Google Calendar for
the 3-day rental window, and creates booking requests the owner confirms.

Built from the client's AGB (`Partydekomiet_AGB_Mietregeln_Chatbot_DE.pdf`).
Those rules are the source of truth and are enforced in code, not just in the
prompt.

**Two separate relationships, do not confuse them:**

| | Who | What |
|---|---|---|
| **Direct client** | Simone Frei, partydekomiet.ch, Zürich | This bot. Real money, real customers |
| **Partner** | "deusnocontroles", Norway, 27 years in IT | Wants an **AI Agent Gallery**: sells agents B2B in Norway/Sweden/Denmark under his name, developer hidden. PartyDekoMiet would be a gallery listing. A massage-studio bot is planned as a second agent |

---

## 2. Where it runs

| | |
|---|---|
| Repo | `github.com/abdul-0987654321/PartyDekoMiet` |
| Branch | `claude/compassionate-darwin-yvck7r` (also the default branch) |
| Host | Render, free plan, region Frankfurt, auto-deploy on push |
| URL | `https://partydekomiet.onrender.com` |
| Keep-alive | UptimeRobot pings `/health` every 5 min (free instances sleep after 15 min) |
| Storage | Google Sheet via Apps Script (`apps-script/Code.gs`). Render's free disk is wiped on every deploy |
| Build / start | `npm ci` / `node src/index.js`, health check `/health` |

**Why a Google Sheet and not a database:** free Render instances have no
persistent disk. The WhatsApp session lives in the sheet, so a deploy does not
cost a QR scan. This pattern is copied from the `united` and `groupswatsapp`
bots, where it runs in production.

---

## 3. Architecture

```
WhatsApp (Baileys) ─► router ─► agent (OpenAI tool calling) ─► tools
      │                 │              │                        ├─ catalog   Shopify products.json + cache
      │                 │              │                        ├─ calendar  availability + [PENDING] events
      │            owner cmds     knowledge/                    ├─ bookings  record + owner notification
      │            takeover       (prompt, rules, FAQ)          └─ handoff   stop and fetch a human
      └─► Google Sheet: session · settings · customers · bookings · chat
```

Nothing about party decoration lives in `src/`. Everything business-specific is
in `knowledge/`, so a second bot is a new knowledge folder plus a new `.env`.

### Files worth knowing

| Path | Why it matters |
|---|---|
| `src/agent/guards.js` | **The safety net.** Deterministic checks on every outgoing message |
| `src/agent/language.js` | Which language to answer in, sticky per conversation |
| `src/settings.js` | Dashboard-editable settings: default → env → saved value |
| `src/calendar/availability.js` | The 3-day overlap logic. A bug here costs the client money |
| `src/whatsapp/router.js` | Owner commands, takeover, rate limit, every "do not answer" path |
| `src/notify/messages.js` | Every owner alert, in German and English |
| `knowledge/faq.json` | The 15 AGB answers, German **verbatim** — do not paraphrase |

---

## 4. Decisions already made, and why

Do not re-litigate these without a reason.

**Guards are code, not prompt.** The system prompt states the rules, but a
prompt can be talked around by a persistent customer. `guards.js` blocks five
things on every outgoing message: claiming a booking is confirmed, offering
delivery or setup, inventing a repair price, requesting payment details, asking
for the customer's address. A blocked reply is replaced with a neutral sentence
and forces a handover. Checks run per sentence and understand negation and
conditions, so "wir bieten keinen Lieferservice an" passes while "wir liefern"
does not. The client's own FAQ answers are whitelisted verbatim, because several
contain the exact words the patterns look for.

**Swiss orthography.** No `ß`, ever. Auto-corrected to `ss`. The AGB is Swiss.

**Service account, not OAuth, for Calendar.** An OAuth app left in "Testing"
mode discards its refresh token after 7 days, which would silently kill
availability checks every week.

**Calendar is the source of truth for availability**, not the database. Bookings
are written to the calendar first. Product identity lives in
`extendedProperties.private`, so renaming an event does not break matching;
manual events fall back to title/description matching.

**Bookings are always PENDING.** Nothing in the code writes CONFIRMED by itself.

**Secrets stay in environment variables**, never in the Sheet — a key written
there sits in the revision history forever.

**Language is decided in code**, before the model call, and written into the
prompt. Leaving it to the model made it drift back to German mid-conversation.

**Voice replies need a preview.** The owner dictates while driving, and speech
recognition makes mistakes, so a dictated reply goes out only after "ok"
(`ownerVoicePreview`, on by default). The target customer comes from the alert
the owner quotes, or a number he says - never guessed.

**Product cards are stored in the chat history** with their picture, so the
dashboard shows what the customer saw. If WhatsApp cannot fetch a picture URL,
the messenger downloads it and sends the bytes; only if that fails too does the
text with the link go out alone.

**Dashboard layout (15 Oct):** bookings are cards with filters (the table hid the
buttons off-screen), chats render pictures, links and *bold*, settings fold the
technical options under "Erweitert" and show readable option names.

**Bot language follows the dashboard switch (testing only).** `botLanguage`
defaults to `dashboard`. Set it to `auto` before going live, or English
customers get German whenever the dashboard is on DE.

**The hourly per-chat cap is off** (`maxMsgsPerChatPerHour: 0`). The owner asked
for this and accepts that a loop can run up OpenAI usage.

---

## 5. Current state

### Works and is verified
- WhatsApp connects (QR **and** pairing code), session survives restarts
- Agent answers, follows the AGB, hands damage and cancellations to a human
- Shopify catalog loads and is searchable in German and English
- Bookings create calendar events and alert the owner
- Dashboard: status with on/off switch, chats, bookings with confirm/cancel,
  WhatsApp linking, 27 settings, DE/EN
- Alerts follow the dashboard language

### Not verified from a cloud session
This environment's network policy blocks `partydekomiet.ch`,
`script.google.com`, `api.openai.com`, `web.whatsapp.com` and `onrender.com`.
Those paths were tested against fakes and by confirming they degrade correctly.
To verify live, add those domains under the environment's Network access.

### Open, waiting on the client
1. **Two businesses.** Simone's WhatsApp profile lists two websites. The bot
   only knows PartyDekoMiet and would answer the other business with rental
   rules. A keyword handoff exists (`Settings → Bot → Keywords for other
   businesses`) but is **empty** until she names the business.
2. ~~Rental window.~~ Answered: Friday pickup returns Monday, he does not work
   on Sundays. Done as the `closedWeekdays` setting (default `sun`), not by
   changing `returnDayOffset`, which would have made every rental longer.
3. **Pickup hours.** Empty, so the bot promises no times.
4. **Deposit mode.** `included` assumed. Could be `separate` or `manual`.
5. **Stock per set.** `defaultStock` 1. Some sets may exist several times.

All five are settings, not code changes.

### Known issues
- Shopify product titles are messy (one contains a phone number). Shown to
  customers as-is.
- The OpenAI key has been revoked once already; a new one is pending from the
  client.
- `demo123` was used as the dashboard password at one point. It holds customer
  phone numbers and chat history — it must be a strong password.

---

## 6. How to continue

```bash
git clone https://github.com/abdul-0987654321/PartyDekoMiet
cd PartyDekoMiet
git checkout claude/compassionate-darwin-yvck7r
npm install
cp .env.example .env          # fill in at least OPENAI_API_KEY
npm test                      # 196 tests
npm run chat -- --dry         # talk to it with no key and no network
npm start                     # full service
```

**Always work on `claude/compassionate-darwin-yvck7r`.** Push with
`git push -u origin claude/compassionate-darwin-yvck7r`. Render auto-deploys from
it. Do not open a pull request unless asked.

**Before every push:** `npm test` must pass. Booting the service and exercising
the endpoints catches what unit tests cannot.

**The dashboard is the debugging tool.** Status shows why the bot did not answer
a given message, the AI error if the key is rejected, and a to-do list of what
is not configured yet.

### Docs in the repo
| File | For |
|---|---|
| `README.md` | Overview, setup order, deployment |
| `docs/CALENDAR_SIMPLE.md` | Calendar setup as numbered clicks with direct links |
| `docs/GOOGLE_SHEET_SETUP.md` | Storage setup |
| `docs/CLIENT_GUIDE.md` | For Simone, simple English, translatable |
| `tools/check-openai-key.py` | Tells you exactly why a key fails |
| `tools/seed-demo.js` | Fake data for screenshots, never on live data |

---

## 7. Next most valuable work

1. **Lead source tracking.** The partner asked whether the bot can tell which
   portal a lead came from. It can, via per-portal `wa.me?text=...` links with a
   hidden code the bot reads from the first message and strips. Small to build,
   and it is the kind of concrete benefit the partner's strategy document says
   is needed to sell. The `appointments` table already has a `sourcePortal`
   field waiting for this.
2. **Nordic languages** (`no` / `sv` / `da`) for the gallery. The structure
   already supports it; it is a translation job in `knowledge/`.
3. **The Studio bot: finish it.** See section 8 below - the data layer is done
   and tested, the WhatsApp-facing half is not.

---

## 8. Studio: what's built vs what's left (2026-10-20)

One dashboard, one database, two businesses (`party` / `studio`), two
WhatsApp numbers - that's the agreed shape. The client (deusnocontroles) sent
3 professionals (Gabriela, Sofia, Lula) and their own written scope: the bot is
a **receptionist**, never one of the professionals, bound to the official
price list, nothing sexual beyond it, no different presentation per platform.
That scope was refused once in an earlier, unacceptable form and accepted in
its current, written-down form - do not relitigate it; `guards-studio.js`
enforces it in code specifically so it can't quietly drift back.

### Built and tested (293/293 tests pass, `npm test`)

| Piece | File | What it does |
|---|---|---|
| Shared DB, tagged | `src/store/db.js` | `customers`/`bookings`/`chat` now carry `business: 'party'\|'studio'`, so one Google Sheet serves both bots without mixing data. Current write sites all still tag `'party'` - the Studio side only exists as new, empty tables so far. |
| Studio directory | `src/studio/directory.js` | CRUD for `professionals`, `services`, `locations` - all dashboard-editable, nothing hardcoded. `profileFor(id)` returns everything the agent needs about one professional (her record + her services + her location) in one call - this is what "always check her profile first" reads from. |
| Studio settings | `src/settings.js` (`studio*` keys) | Owner/alert numbers, calendar ID, min notice, buffer minutes, payment mode, cancellation rule, example confirmation message, blocked-day keywords - same dashboard-editable pattern as the party settings, kept in their own group. |
| Time-slot availability | `src/calendar/slots.js` | `checkSlot()` - is an HH:MM-HH:MM slot free for one professional on one date? Deliberately **not** a reuse of `availability.js` (date-window logic); appointments need hour-level overlap, buffer-after-appointment, and minimum-notice, none of which the rental-window module does. Caught and fixed a real timezone bug while testing (naive `new Date()` parsing used the server's UTC offset instead of Europe/Zurich for the minimum-notice check - would have silently refused or allowed the wrong slots). |
| Studio guards | `src/agent/guards-studio.js` | Code-level, not prompt-level: blocks the bot speaking as the professional herself, offering/negotiating sexual extras, quoting a price that isn't an active service's own price, or presenting an appointment as confirmed before the owner has it. Same per-sentence / negation-aware / FAQ-whitelist pattern as `guards.js`. |
| Studio knowledge | `knowledge-studio/` | `persona.md` (receptionist tone), `rules.md` (the hard limits, matching the client's written scope), `business.json` (studio-wide facts only - nothing per-person or per-price, that's all in the DB), `faq.json` (empty, fill in as the client answers). `from-files.js` now reads `KNOWLEDGE_DIR` so this folder loads without touching the PartyDekoMiet one. |

### Not built yet - this is the real remaining work

1. **A second WhatsApp connection.** `src/whatsapp/client.js` and `index.js`
   are wired for exactly one Baileys connection. The agreed shape (one
   process, two numbers, shared DB, one dashboard) needs this parameterised -
   two connections, each tagging its own `business`, both feeding one router
   and one agent configured per business (which `knowledge-*` folder, which
   guards, which settings group). This is the biggest remaining piece and the
   one most likely to have surprises; don't underestimate it.
2. **Studio agent tools.** `src/agent/tools/index.js` only has PartyDekoMiet's
   tools (search_products, check_availability, create_booking, ...). The
   Studio needs its own set: `get_professional_profile` (→
   `directory.profileFor`), `list_professionals`, `check_slot` (→
   `slots.checkSlot`), `create_appointment` (writes the `appointments` table +
   a calendar event, always PENDING - mirrors `bookings.js`'s
   `create`/`setStatus` pattern exactly, including "never write CONFIRMED
   itself").
3. **Dashboard: business switch + Professionals/Services/Locations pages.**
   Nothing in `public/` or `src/http/server.js` knows about `business` or the
   new tables yet. Needs: a Party/Studio switch in the dashboard shell that
   filters chats/bookings/status by `business`; new pages to add/edit
   professionals (with photo upload - `db.putFile` already supports this),
   services and locations; booking/appointment lists already have a working
   pattern to copy from `bookings.html`.
4. **Owner commands and notifications**, duplicated per business
   (`src/whatsapp/router.js` owner commands, `src/notify/messages.js`) - these
   currently assume PartyDekoMiet's wording and the single `ownerWhatsapp`
   setting.
5. **Pre-fill the 3 known professionals** (Gabriela/Sofia/Lula) once
   `professionals`/`services`/`locations` are reachable from the dashboard -
   their data is in this Fiverr chat already, just needs entering.

### Unrelated bug found and fixed while testing the deploy (2026-10-20)

Live logs showed WhatsApp stuck in a reconnect loop: `Apps Script error: Sorry,
it is not possible to delete all non-frozen rows`, repeating every few seconds.
Not caused by this session's changes (`apps-script/Code.gs` and
`whatsapp/auth-state.js` were last touched 15 Oct) - it surfaced now because
`clearSession()` fully wipes the `session` sheet row by row whenever WhatsApp
reports a logged-out/invalid session, and Google Sheets refuses a `deleteRow()`
that would remove every remaining non-frozen row. Fixed in `Code.gs`'s
`remove_()`: blank the row's content instead of deleting it - `load_()` already
treats an all-empty row as not there, so nothing else changes.

**This fix lives in Google Apps Script, not in this repo's deploy path.**
Pushing to GitHub does nothing for it. It must be pasted into the Apps Script
editor by hand: open the Sheet → Extensions → Apps Script → replace `Code.gs`'s
contents with the new version from this repo → Save → **Deploy → Manage
deployments → edit (pencil) → Version: New version → Deploy** (keeps the same
URL, per `docs/GOOGLE_SHEET_SETUP.md`). Until that's done, WhatsApp cannot stay
connected on this client's Sheet.

Known trade-off of the fix, not urgent: blanked rows are never removed, so a
table that adds and removes many rows (the `session` table especially, as
WhatsApp keys rotate) grows blank rows over time instead of shrinking. Not a
problem at this volume; worth a periodic compaction pass if the Sheet ever
gets large and slow.

### Why the data layer came first

Everything the client doesn't have yet - working hours, final prices, the
"Extras" question, which professional goes with which location - is a
dashboard-editable record now, not a code change waiting on him to answer a
message. That was the explicit ask: he fills gaps in himself later, instead of
every missing detail blocking a push. Items 1-4 above are what turns that data
layer into a bot that actually answers on WhatsApp.
