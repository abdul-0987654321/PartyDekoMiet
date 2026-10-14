# PartyDekoMiet WhatsApp Assistant — guide for Simone

Simple guide for daily use. It can be translated to German as it is.

---

## What the assistant does by itself

It answers WhatsApp messages 24/7: where to pick up, how long the rental is, the
deposit, late fees, whether you deliver (you don't), and what happens if
something breaks. It asks about the occasion, theme, the child's age and the
party date, shows matching sets with picture, price and shop link, and checks
your calendar for the three rental days.

**It never confirms a booking.** It can say a set *looks* free and that the
request has been passed to you. Only you confirm, after you see the payment.

## What it always passes to you

- damage, loss, missing parts
- cancellations and changes to an existing booking
- requests to extend a rental
- any request for an exception
- anything it is unsure about

When this happens it goes quiet in that chat for 12 hours so it cannot talk over
you, and you get a WhatsApp message.

---

## Your daily jobs

### 1. A new booking request arrives

You get a WhatsApp message with everything: customer, phone, set, pickup and
return date, occasion, theme, and the shop link.

At the same time an entry appears in your calendar:

```
[PENDING] Einhorn Set Rosa – Anna Muster
```

`[PENDING]` means: *requested, not paid yet.* The set is already blocked for
those days, so nobody else can be told it is free.

### 2. Confirming a booking

When you see the paid order in the Shopify shop:

1. Open the event in Google Calendar
2. Change `[PENDING]` to `[CONFIRMED]` in the title
3. Save

That is all. Nothing else to click.

> Don't delete the `[` `]` brackets, and don't delete the text at the bottom of
> the description ("Buchungs-ID: ..."). The assistant uses them.

### 3. Cancelling a booking

Delete the calendar event. The days become free again immediately.

### 4. Blocking days (holiday, closed, fully booked)

Create an **all-day** event with one of these words in the title:

```
Geschlossen   Ferien   Blocked   Closed   Urlaub
```

Everything is blocked on those days, for every set. For a whole week, make one
all-day event across the week.

> It has to be an **all-day** event. An appointment with a time (e.g. 14:00–15:00)
> does not block anything — so your normal appointments stay private and harmless.

### 5. Taking over a chat yourself

Just reply in WhatsApp as normal. The assistant notices and goes quiet in that
chat for 12 hours. Nothing to switch off.

To let it take over again sooner, send from your own WhatsApp:

```
/resume 41791234567
```

---

## Commands you can send from your WhatsApp

| Command | What it does |
|---|---|
| `/status` | overview: is the bot on, is WhatsApp connected, how many sets are loaded |
| `/pause 41791234567` | stop the bot in one customer's chat |
| `/resume 41791234567` | let it answer there again |
| `/off` | stop the bot in **all** chats |
| `/on` | start it again |
| `/help` | this list |

Write the number without `+` and without spaces.

---

## Answering by voice (for example while driving)

1. The assistant sends you a notification about a customer.
2. **Reply to that notification** (swipe it to the right, or long-press → Reply)
   with a **voice message**, in any language. Say what to answer and in which
   language, for example:
   *"Sag ihm, das Set ist am Samstag frei, auf Italienisch."*
3. You get a **preview** of the exact message, in the language you asked for.
4. Answer **ok** to send it, or **nein** to throw it away.

The assistant then stays quiet in that chat, so it does not talk over you.

- No language named → it answers in the customer's language (German if unknown).
- You can also say the number instead of replying to a notification:
  *"41791234567, das Set ist frei, auf Spanisch."*
- Typing works too: reply to a notification with text instead of a voice note.
- Customers can send voice messages as well. The assistant listens to them and
  answers in writing.

---

## Closed days

Settings → Business rules → **Closed days**. Default: Sunday.

- No pickup on a closed day.
- A return that would fall on a closed day moves to the next open day:
  pickup **Friday** → return **Monday**. The set stays blocked until Monday.

---

## The dashboard

Open the web address you were given and log in with the dashboard password.
Top right you can switch between **DE** and **EN**.

| Page | What it is for |
|---|---|
| **Status** | is everything running: WhatsApp, storage, catalog, calendar |
| **Chats** | read conversations and answer by hand |
| **WhatsApp** | link the phone again: QR code or a code typed on the phone |
| **Bookings** | all requests with status, dates and customer |
| **Settings** | prices, deposit, pickup times, rental length, bot language |

### Things worth changing in Settings

- **Pickup times** — the times the assistant may suggest. Leave it empty and it
  will only say that the time is agreed in advance.
- **Deposit** and **late fee** — if the amounts ever change
- **Return = pickup + X days** — how the three rental days are counted
- **Buffer days after return** — set to 1 if you want a day to check and clean
  before a set can go out again
- **Bot language** — `auto` replies in the customer's language, or force German
- **Bot active** — the same as `/off`

Changes take effect immediately. Nothing has to be restarted.

---

## If something is wrong

**The assistant stopped answering.** Open the dashboard → Status. If WhatsApp is
not "connected", go to the WhatsApp page and link the phone again. Two ways:

- **QR code** — WhatsApp on the phone → Settings → Linked devices → Link a device → scan
- **With a number** — easier if the phone is not next to the screen. Type the bot
  phone's number, then on the phone choose *"Link with phone number instead"* and
  type the 8-character code shown on the dashboard.

**It answered something wrong.** Reply in the chat yourself — it steps aside at
once. Then tell your developer what it said, so the rule can be fixed.

**A set shows as free although it is out.** Check the calendar event: it must
contain `[PENDING]` or `[CONFIRMED]` in the title. An event without either does
not block anything.

**Everything is down.** Messages are not lost — WhatsApp holds them and delivers
them when the assistant is back.
