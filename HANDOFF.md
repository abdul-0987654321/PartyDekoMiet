# Handoff — PartyDekoMiet WhatsApp AI agent

Everything a new session (or a new developer) needs to continue without asking.
Read this first, then `README.md`.

Last updated 2026-10-22. Two live bugs fixed: the WhatsApp 405 login failure
(no QR ever appeared) and a crash on every Studio message. See section 8. The Studio bot is fully built and live in the
dashboard: its own WhatsApp number, agent, guards, calendar, appointments, and
a Party/Studio switch with Professionals/Services/Locations pages. What's left
is data entry (the roster, the calendar ID, the phone number), not code - see
section 8.

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
3. **The Studio bot: fill in the data.** See section 8 below - everything is
   built and tested; what's left is entering the roster, calendar ID and
   WhatsApp number from the dashboard, not writing more code.

---

## 8. Studio: complete and live in the dashboard (2026-10-20)

One dashboard, one database, two businesses (`party` / `studio`), two
WhatsApp numbers - that's the agreed shape, and it's now fully built. The
client (deusnocontroles) sent 3 professionals (Gabriela, Sofia, Lula) and
their own written scope: the bot is a **receptionist**, never one of the
professionals, bound to the official price list, nothing sexual beyond it,
no different presentation per platform. That scope was refused once in an
earlier, unacceptable form and accepted in its current, written-down form -
do not relitigate it; `guards-studio.js` enforces it in code specifically so
it can't quietly drift back.

### Built and tested (337/337 tests pass, `npm test`)

| Piece | File | What it does |
|---|---|---|
| Shared DB, tagged | `src/store/db.js` | `customers`/`bookings`/`chat` carry `business: 'party'\|'studio'`, so one Google Sheet serves both bots without mixing data. |
| Studio directory | `src/studio/directory.js` | CRUD for `professionals`, `services`, `locations` - all dashboard-editable, nothing hardcoded. `profileFor(id)` returns everything the agent needs about one professional in one call. |
| Studio settings | `src/settings.js` (`studio*` keys, plus `studioBotEnabled`) | Owner/alert numbers, calendar ID, min notice, buffer minutes, payment mode, cancellation rule, example confirmation, blocked-day keywords, and its own on/off switch - independent from Party's, so turning one bot off never silences the other. |
| Time-slot availability | `src/calendar/slots.js` | `checkSlot()` - hour-level overlap, buffer-after-appointment and minimum-notice, timezone-correct (`wallTimeToUtc`, fixed a real UTC-vs-Europe/Zurich bug caught while testing). |
| Studio appointments | `src/appointments.js`, `src/calendar/studio-service.js` | Mirrors `bookings.js`: `create`/`list`/`setStatus`, always PENDING, calendar is the source of truth. |
| Studio agent tools | `src/agent/tools/studio.js` | Professional/service lookups, slot checks, appointment requests, handoff - never answers from memory, always reads the directory/calendar at reply time. |
| Studio guards | `src/agent/guards-studio.js` | Code-level: blocks the bot speaking as the professional herself, offering/negotiating sexual extras, quoting an invented price, or confirming an appointment early. |
| Studio knowledge | `knowledge-studio/` | `persona.md`, `rules.md`, `business.json`, `faq.json`. `from-files.js` takes `dir`/`KNOWLEDGE_DIR` so this loads independently of `knowledge/`, in the same process. |
| **Second WhatsApp connection** | `src/whatsapp/client.js` (factory), `src/whatsapp/auth-state.js` (namespaced session keys), `index.js` (`bootStudio()`) | Two independent Baileys sockets, one process. Studio boots right after Party and is fully try/catch'd so a Studio problem (missing calendar ID, no owner number yet) can never take Party down. Smoke-tested: both reconnect loops run side by side, shut down cleanly together. |
| **Owner commands & notifications per business** | `src/whatsapp/router.js` (`BUSINESS_SETTINGS` map), `src/notify/owner.js` | `/on`, `/off`, `/status`, pause-state, the chat/customer business tag, and which settings key is read (`studioOwnerWhatsapp`, `studioCalendarId`, `studioBotEnabled`) are all business-aware. `notify/owner.js` has `appointmentRequest()` alongside `bookingRequest()`. |
| **Dashboard: Party/Studio switch + directory pages** | `public/app.js` (`BIZ`, `renderNav`, `withBiz()`), `src/http/server.js` (`pick(req)`) | A switch in the nav changes which business's status/chats/bookings/WhatsApp the whole dashboard shows - every API call under `/api/status`, `/api/whatsapp*`, `/api/chats*`, `/api/bookings*`, `/api/test/chat` auto-carries `?biz=studio`. New pages `professionals.html`, `services.html`, `locations.html` (full CRUD, photo upload for professionals via `/api/studio/professionals/:id/photo` + `/api/studio/photo/:fileId`). `bookings.html` renders either booking or appointment fields depending on `BIZ`. `settings.html` shows the Studio's own settings group when Studio is selected. |

Verified end-to-end in this session: booted the whole app with a memory
backend (no real Sheet/OpenAI/calendar configured) and confirmed both bots
boot independently, `/api/status?biz=studio` returns Studio's own state
without leaking Party's, `/api/studio/professionals` works, and a clean
shutdown saves both. See `test/server-studio.test.js` for the automated
version of that check.

### What's left - all data entry, not code

1. **Pre-fill Gabriela/Sofia/Lula.** The dashboard can take this now:
   open the Studio side → Locations (add the studio's address(es)) →
   Professionals (add each one, with photo, languages, working hours) →
   Services (add each one's services with duration and price). Nothing
   else needs to change in the code for this.
2. **Studio's own WhatsApp number.** Dashboard → switch to Studio → WhatsApp
   → scan the QR (or pair by number), same flow as Party's.
3. **Studio's calendar.** Dashboard → Studio settings → paste the Studio's
   Google Calendar ID (share that calendar with the same service account
   email Party's Calendar status row already shows).
4. **Studio's owner/alert numbers**, cancellation rule, payment mode,
   minimum notice, buffer time - all in Dashboard → Studio settings, same
   place as the calendar ID above.
5. **FAQ**, once the client answers specific questions - add entries to
   `knowledge-studio/faq.json` (or wire `KNOWLEDGE_SOURCE=sheet` for it the
   same way Party could be, if the client should edit these without a
   developer - not done, not asked for yet).

None of 1-4 need a push or a redeploy. They're exactly the kind of gap this
was built to let the client fill in himself (see "Why the data layer came
first" below).

### Studio bot threw on every message - fixed (2026-10-22)

Found right after the 405 fix let the QR through: the first real Studio message
answered "Sorry, I am having a technical problem right now." Log line:

    AI call failed for ...@lid: Cannot read properties of undefined (reading 'address')

**Cause.** `src/agent/prompt.js` was written for the rental shop and read
`b.pickup.address` unconditionally. The Studio's `business.json` has no `pickup`
object at all - by design, its addresses live in the dashboard `locations` table.
So the prompt threw before the model was ever called, on every message.
`business.money.depositChf` in the request-flow section was the same bug again.

Worse than the crash: even once it stopped throwing, the Studio was being handed
PartyDekoMiet's tool list (`search_products`, `send_product`) and the decoration
booking flow, for tools it does not have.

**Fix.** Every block in `renderBusiness()` is now conditional, and the tools +
request flow moved out of `prompt.js` into each business's own knowledge folder:

| File | Belongs to |
|---|---|
| `knowledge/workflow.md` | rental: search_products, send_product, check_availability, create_booking_request |
| `knowledge-studio/workflow.md` | studio: list_professionals, get_professional_profile, check_appointment_slot, create_appointment_request |

`from-files.js` loads `workflow.md` when present; `{{depositChf}}` is the one
value substituted from business.json. Party's generated prompt was verified
byte-identical before and after this refactor.

`test/prompt-businesses.test.js` (11 tests) builds BOTH prompts for real and
asserts neither leaks the other's tools - that is the regression guard, since
this class of bug only shows up at runtime on the business that lacks a field.

---

### Boot loop: "Google Sheet not reachable" (2026-10-22)

After the deploy, boot looped on:

    Google Sheet not reachable: Cannot convert undefined or null to object

That message was wrong twice over: the Sheet WAS reachable (it answered), and
the error names a JS type error rather than the cause. What actually happened:
'load' answered `{ok:true}` with no `data`, so `Object.entries(undefined)` threw
three frames later in `db.init()`.

**Root cause: the deployed Apps Script is older than this app.** Deploying this
repo does NOT update Code.gs - it lives in the client's Google account and has
to be pasted into the Apps Script editor by hand. The Studio work added four
tables (professionals, services, locations, appointments) that an older
deployment does not serve.

**Fixed in `src/store/backend-sheets.js`:** `load()` now validates the answer
and fails with the cause and the fix in the message, naming any table that came
back empty. `state.storageError` says "storage failed" rather than "not
reachable". `test/backend-sheets.test.js` covers it.

**If this appears again, the fix is in Google, not in this repo:**
open the Sheet - Extensions - Apps Script - paste the current
`apps-script/Code.gs` - Deploy - Manage deployments - Edit (pencil) - Deploy.
Editing the code alone is not enough; the deployment has to be updated too.

---

### The 405 that blocked both numbers - root cause found (2026-10-22)

Symptom: neither number could log in. The dashboard showed no QR code at all,
because the handshake was rejected with `405: Connection Failure` before
WhatsApp ever issued one.

**Cause.** `fetchLatestBaileysVersion()` does not ask WhatsApp anything - it
reads a protocol version hardcoded in the Baileys repo, last changed in March
2026. WhatsApp rejects that build. The earlier attempted workaround (pinning a
constant, commit bd2437a) pinned `2.3000.1033893291`, which is *older* than
`2.3000.1035194821`, the build the bug reports name as broken - so it could not
have worked either.

**Fix.** `src/whatsapp/wa-version.js` resolves the version in this order:

1. `WHATSAPP_VERSION` env var, if set (escape hatch, no redeploy needed -
   accepts `2.3000.1044015310` or `[2,3000,1044015310]`)
2. `fetchLatestWaWebVersion()` - the build web.whatsapp.com is serving right now
3. `fetchLatestBaileysVersion()` - but `isLatest:false` counts as a failure, not
   an answer; that flag is exactly how the stale bundled version sneaks through
4. `PINNED_FALLBACK` - newest version reported accepted (2026-07-28)

`@itsliaaa/baileys@0.3.18-final` already exports `fetchLatestWaWebVersion`, so
no package change was needed. 13 tests in `test/wa-version.test.js` cover the
ordering; they inject fake fetchers, so they run without node_modules.

**Not yet confirmed against real WhatsApp** - it could not be tested from a
cloud session. The proof is clicking "Connect" on the dashboard. If it still
fails, re-check Baileys#2679 for a newer working version number and set
`WHATSAPP_VERSION` in Render rather than editing code.

Do NOT remove `MAX_AUTO_RECONNECTS` (commit c399ec7) whatever else is tried -
the unbounded retry loop was a real bug that made the block worse.

Sources: WhiskeySockets/Baileys#2370, #2679; NousResearch/hermes-agent#99256.

---

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
