# Google Calendar setup

The bot checks availability and writes booking requests into one Google Calendar.
About 15 minutes, once.

## Who creates the calendar

**Create it in your own Google account** — the same one that holds the bot's
Google Sheet. Then share it with the client.

That order matters. The service account needs "Make changes to events" on the
calendar, and you can grant that yourself in seconds if the calendar is yours.
If the calendar lives in the client's account, every change needs the client to
click something, and a wrong click silently breaks availability checks.

The client still sees everything and can edit bookings — you give them edit
access in step 5. Simone's personal "Simone Frei" calendar stays untouched, so
her private appointments can never block a rental or be read by the bot.

## 1. Create the booking calendar

1. https://calendar.google.com → left side, next to **Other calendars**, click **+** → **Create new calendar**
2. Name: `PartyDekoMiet Buchungen`
3. Time zone: **(GMT+01:00) Zurich**
4. **Create calendar**

## 2. Create the service account

A service account is a robot Google account with its own key. We use it instead
of normal OAuth login because an OAuth app left in "Testing" mode throws its
refresh token away after 7 days — the bot would silently stop checking
availability every week. A service account key does not expire.

1. https://console.cloud.google.com → create a project, e.g. `partydekomiet-bot`
2. **APIs & Services → Library** → search **Google Calendar API** → **Enable**
3. **APIs & Services → Credentials → Create credentials → Service account**
   - Name: `partydekomiet-bot`
   - **Create and continue**, skip the optional roles, **Done**
4. Click the new service account → **Keys** tab → **Add key → Create new key → JSON**
5. A `.json` file downloads. Keep it safe — it is a password.

Open the file and copy the `client_email`. It looks like:

```
partydekomiet-bot@partydekomiet-bot.iam.gserviceaccount.com
```

## 3. Share the calendar with the service account

This is the step people miss. Sharing with *your* Google account is not enough.

1. Google Calendar → hover the new calendar → ⋮ → **Settings and sharing**
2. **Share with specific people or groups** → **Add people**
3. Paste the service account's `client_email`
4. Permission: **Make changes to events** (not "See all event details")
5. **Send**

> The service account cannot accept an invitation, and it will not appear as a
> "pending" guest. Once added with the right permission it simply works.

## 4. Get the calendar ID

Same settings page → **Integrate calendar** → **Calendar ID**. It looks like:

```
c_8f3a...@group.calendar.google.com
```

## 5. Give the client access

Same sharing box → add `partydekomiet@gmail.com` → **Make changes to events**.
Simone can then see bookings in her own Google Calendar app and switch a booking
from `[PENDING]` to `[CONFIRMED]`.

## 6. Put it into the bot

The key goes in as one line of base64. On Mac or Linux:

```bash
base64 -i ~/Downloads/partydekomiet-bot-xxxx.json | tr -d '\n'
```

On Windows PowerShell:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("$HOME\Downloads\partydekomiet-bot-xxxx.json"))
```

In Render → **Environment**:

```
GOOGLE_SERVICE_ACCOUNT_JSON_B64=<the long base64 line>
GOOGLE_CALENDAR_ID=c_8f3a...@group.calendar.google.com
```

`GOOGLE_CALENDAR_ID` can also be set later in the dashboard under
**Settings → Calendar**. The key has to stay an environment variable: it is a
secret and does not belong in a Google Sheet.

## 7. Check it

Restart the service and open the dashboard. **Calendar** should read *connected*.
If it does not, the status page shows the actual error. The two common ones:

| Message | Cause |
|---|---|
| `Calendar not found` | wrong `GOOGLE_CALENDAR_ID`, or the calendar is not shared with the service account |
| `Calendar access denied` | shared, but with "See all event details" instead of **Make changes to events** |

Both messages print the service account address to share with.

## How the bot uses the calendar

- One all-day event per booked set, spanning pickup day to return day
- Title: `[PENDING] <Set> – <Customer>`
- The product id is stored in the event's hidden properties, so renaming an event
  does not break availability
- `[PENDING]` and `[CONFIRMED]` both block the set for those days
- An **all-day** event containing `Blocked`, `Geschlossen`, `Ferien`, `Closed` or
  `Urlaub` in the title blocks **every** set that day — that is how Simone closes
  a weekend. The keywords are editable in the dashboard.
- Timed events and ordinary personal appointments are ignored
