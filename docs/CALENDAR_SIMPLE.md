# Calendar setup — the short version

Do these in order. Nothing else matters. About 15 minutes.

> **Everything here happens in YOUR OWN Google account.** Not the client's.
> You do not need anything from Simone for steps 1–8.

---

## PART A — Make a calendar (2 min)

**1.** Go to **calendar.google.com**

**2.** On the left, find **"Other calendars"**. Click the **+** next to it → **Create new calendar**

**3.** Name: `PartyDekoMiet Buchungen`
Time zone: **(GMT+01:00) Zurich**
Click **Create calendar**

✅ Done. A new calendar now exists in your account.

---

## PART B — Make a robot account (7 min)

This is a Google account for the bot. It is not a person and has no password —
it logs in with a key file.

**4.** Go to **console.cloud.google.com**
If it asks you to create a project: create one, call it `partydekomiet`.

**5.** In the search bar at the top, type **"Google Calendar API"** → open it →
click the blue **ENABLE** button.
*(If it already says "Manage", it is already enabled. Fine.)*

**6.** In the search bar, type **"Service Accounts"** → open it →
**+ CREATE SERVICE ACCOUNT**
- Name: `partydekomiet-bot`
- Click **CREATE AND CONTINUE**
- The next screen asks for a role → **skip it**, click **CONTINUE**
- Click **DONE**

**7.** You now see it in a list. Click on it.
Go to the **KEYS** tab → **ADD KEY** → **Create new key** → choose **JSON** → **CREATE**

📁 A file downloads. Something like `partydekomiet-abc123.json`.
**Keep this file. It is a password.**

**8.** Open that file with Notepad / TextEdit. Find the line that says
`"client_email"`. Copy the address. It looks like:

```
partydekomiet-bot@partydekomiet.iam.gserviceaccount.com
```

---

## PART C — Let the robot into the calendar (2 min)

### ⚠️ This is the step everybody gets wrong. Do not skip it.

**9.** Back to **calendar.google.com**

**10.** Hover over `PartyDekoMiet Buchungen` on the left → click the **⋮** (three
dots) → **Settings and sharing**

**11.** Scroll down to **"Share with specific people or groups"** → **+ Add people and groups**

**12.** Paste the `client_email` address from step 8.

**13.** ⚠️ In the dropdown next to it, choose **"Make changes to events"**.
NOT "See all event details". The bot has to write, not only read.

**14.** Click **Send**.

> Nothing will appear to happen. There is no invitation to accept, no "pending".
> That is normal — a robot account cannot accept invitations. It just works.

---

## PART D — Get the calendar ID (1 min)

**15.** Stay on the same settings page. Scroll down to **"Integrate calendar"**.

**16.** Copy the **Calendar ID**. It looks like:

```
c_8f3a9b2c...@group.calendar.google.com
```

---

## PART E — Put it into Render (3 min)

**17.** Open the downloaded `.json` file again. Select **everything**
(Ctrl+A / Cmd+A) and copy. It starts with `{` and ends with `}`.

**18.** Render → your service → **Environment** → add two variables:

| Key | Value |
|---|---|
| `GOOGLE_SERVICE_ACCOUNT_JSON` | paste the whole file contents |
| `GOOGLE_CALENDAR_ID` | the ID from step 16 |

> No base64. No commands. Just paste the file contents.

**19.** Save. Render restarts by itself.

**20.** Open the dashboard. On the Status page, **Calendar** should say
**connected**.

---

## PART F — Give the client access (1 min)

**Only now** does Simone come in.

**21.** calendar.google.com → the calendar → ⋮ → **Settings and sharing** →
**Add people** → `partydekomiet@gmail.com` → **Make changes to events** → Send.

She gets an email, accepts, and the calendar appears in her Google Calendar app.
She can then see bookings and change `[PENDING]` to `[CONFIRMED]`.

---

## If the dashboard shows an error

| Message | What it means | Fix |
|---|---|---|
| `Calendar not found` | wrong ID, or the robot was never added | redo steps 12–14 and 16 |
| `Calendar access denied` | the robot was added, but only as a viewer | step 13 → change to **Make changes to events** |
| `not valid JSON` | the paste was incomplete | copy the file again, all of it, `{` to `}` |

The dashboard prints the robot's email address in the error, so you can check
you added the right one.

---

## What the client's existing access does NOT do

Simone sharing her **"Simone Frei"** calendar with your Google account does not
help the bot. That is her personal calendar, and the bot uses a different
account (the robot from Part B).

We deliberately do **not** use her personal calendar:
- the bot would see her private appointments
- her dentist appointment could block a rental
- every change would need her to click something

The new calendar is cleaner, and she still sees everything through step 21.
