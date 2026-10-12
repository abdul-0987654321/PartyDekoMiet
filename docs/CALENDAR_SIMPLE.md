# Calendar setup — click by click

Open each link, do the one thing written under it, move on.
The links jump straight to the right page, so you never have to search a menu.

Total: 15 minutes.

> Everything is done in **YOUR OWN** Google account. You need nothing from the
> client until the very last step.

---

## STEP 1 — Create the calendar

🔗 **https://calendar.google.com**

On the left side, scroll down to **"Other calendars"**.
Click the small **+** → choose **"Create new calendar"**.

Fill in:
- Name: `PartyDekoMiet Buchungen`
- Time zone: **(GMT+01:00) Zurich**

Click the blue **"Create calendar"** button.

Wait 5 seconds. The calendar appears in the left list.

---

## STEP 2 — Create a Google Cloud project

🔗 **https://console.cloud.google.com/projectcreate**

- Project name: `partydekomiet`
- Location: leave as it is

Click **CREATE**. Wait ~20 seconds until it is ready.

> If you already have a project, you can use it. Nothing breaks.

---

## STEP 3 — Switch on the Calendar API

🔗 **https://console.cloud.google.com/apis/library/calendar-json.googleapis.com**

Make sure the project name at the **top left** says `partydekomiet`.
If not, click it and pick `partydekomiet`.

Click the blue **ENABLE** button.

> If the button says **MANAGE** instead, it is already on. Go to step 4.

---

## STEP 4 — Create the robot account

🔗 **https://console.cloud.google.com/iam-admin/serviceaccounts/create**

Screen 1:
- Service account name: `partydekomiet-bot`
- Click **CREATE AND CONTINUE**

Screen 2 (asks for a role):
- Click **CONTINUE** — do not pick anything

Screen 3:
- Click **DONE**

> A "service account" is a login for a program. It has no password and no inbox.
> It is how the bot gets into the calendar.

---

## STEP 5 — Download the key file

🔗 **https://console.cloud.google.com/iam-admin/serviceaccounts**

You see a table with `partydekomiet-bot` in it. **Click on the email address**
in that row.

Now at the top, click the tab **KEYS**.

Click **ADD KEY** → **Create new key** → select **JSON** → **CREATE**.

📁 A file downloads, e.g. `partydekomiet-4f2a1b.json`

**Do not lose this file. It is a password.**

---

## STEP 6 — Copy the robot's email address

Open the downloaded file with **Notepad** (Windows) or **TextEdit** (Mac).

Find the line starting with `"client_email"`. Copy only the address inside the
quotes:

```
"client_email": "partydekomiet-bot@partydekomiet.iam.gserviceaccount.com",
                 └──────────────── copy this part ─────────────────────┘
```

Paste it somewhere for a moment (Notes, a chat to yourself).

---

## STEP 7 — ⚠️ Let the robot into the calendar

**This is the step that fails for everybody. Read it twice.**

🔗 **https://calendar.google.com**

1. On the left, move the mouse over **`PartyDekoMiet Buchungen`**
2. Three dots **⋮** appear → click them
3. Click **"Settings and sharing"**
4. Scroll down to the box **"Share with specific people or groups"**
5. Click **"+ Add people and groups"**
6. Paste the robot email from step 6
7. **Next to it there is a dropdown. Open it.**
   Choose **"Make changes to events"**
   ❌ NOT "See all event details"
   ❌ NOT "See only free/busy"
8. Click **Send**

### After clicking Send, NOTHING will happen.

No confirmation. No pending invite. No email.
**This is correct.** A robot cannot accept invitations. It already works.

To check it worked: reload the page, scroll to the same box. The robot's address
should be listed there with "Make changes to events" next to it.

---

## STEP 8 — Copy the Calendar ID

Stay on the same page (Settings and sharing).

Scroll further down to the section **"Integrate calendar"**.

The first field is **Calendar ID**. Copy it. It looks like:

```
c_8f3a9b2cd4e5f6a7b8c9@group.calendar.google.com
```

---

## STEP 9 — Put both values into Render

Open the downloaded `.json` file again.
Select everything: **Ctrl+A** (Windows) or **Cmd+A** (Mac), then copy.

It starts with `{` and ends with `}`. Copy ALL of it, including both brackets.

Go to Render → your service → **Environment** → **Add Environment Variable**.

Add these two:

| Key | Value |
|---|---|
| `GOOGLE_SERVICE_ACCOUNT_JSON` | paste the whole file contents |
| `GOOGLE_CALENDAR_ID` | the ID from step 8 |

Click **Save Changes**. Render restarts automatically (~2 minutes).

> No base64. No terminal commands. Just copy and paste the file.

---

## STEP 10 — Check it

Open the dashboard → **Status** page.

The row **Calendar** should say **connected**.

If it shows an error instead:

| Error on screen | What went wrong | Go back to |
|---|---|---|
| `Calendar not found` | wrong Calendar ID, or step 7 was not done | step 7 and step 8 |
| `Calendar access denied` | robot added, but only as a viewer | step 7, point 7 |
| `not valid JSON` / `could not be parsed` | the paste was cut off | step 9, copy the whole file |

The error message on the dashboard prints the robot's email address, so you can
compare it with what you added in step 7.

---

## STEP 11 — Only now: invite the client

🔗 **https://calendar.google.com** → `PartyDekoMiet Buchungen` → ⋮ →
**Settings and sharing** → **Add people and groups**

- Email: `partydekomiet@gmail.com`
- Permission: **Make changes to events**
- **Send**

She gets a real email, clicks accept, and the calendar appears in her Google
Calendar app on her phone.

---

## Questions you might have

**Do I need the client's calendar access that she already sent me?**
No. That is her personal calendar. The bot uses the new one from step 1. You can
ignore what she shared.

**Why not just use her existing calendar?**
The bot would see all her private appointments, her dentist appointment could
block a rental, and every change would need her to click something.

**Is the key file dangerous?**
It gives access to this one calendar only, because that is the only thing you
shared with it in step 7. Still, do not put it in GitHub or send it in a chat.

**What does the client do with the calendar afterwards?**
Two things: change `[PENDING]` to `[CONFIRMED]` when a payment arrives, and
create an all-day event called `Geschlossen` to block a day.
