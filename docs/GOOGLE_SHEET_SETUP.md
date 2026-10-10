# Google Sheet storage – setup

The bot keeps everything that must survive a restart in a Google Sheet, because
Render wipes the container disk on every restart and deploy. Without this, the
owner would have to scan a new WhatsApp QR code after every deploy.

Takes about 5 minutes. Do this **before** the first start of the bot.

## 1. Create the Sheet

1. Go to https://sheets.new
2. Name it `PartyDekoMiet Bot`

## 2. Add the script

1. In the Sheet: **Extensions → Apps Script**
2. Delete the contents of `Code.gs`
3. Paste the full contents of [`apps-script/Code.gs`](../apps-script/Code.gs)
4. Save (disk icon)

## 3. Run the one-time setup

1. In the Apps Script editor pick the function **`setup`** in the dropdown → **Run**
2. Google asks for permission the first time:
   **Review permissions → choose the account → Advanced → Go to … (unsafe) → Allow**
   (This is normal — the script is yours and unpublished, so Google shows a warning.)
3. Open **Execution log**. It prints:
   ```
   Tabs ready. SHEET_SECRET=xxxxxxxx-xxxx-...
   ```
4. Copy that value — it becomes `SHEET_SECRET` in the bot's environment.

The tabs `session`, `customers`, `bookings`, `chat`, `state` and `knowledge` now exist.
Leave them empty; the bot fills them.

## 4. Deploy as a Web App

1. **Deploy → New deployment**
2. Gear icon next to "Select type" → **Web app**
3. Settings:
   - **Description**: `PartyDekoMiet bot storage`
   - **Execute as**: `Me`
   - **Who has access**: `Anyone`
4. **Deploy**, approve again if asked
5. Copy the **Web app URL**. It ends in `/exec`:
   ```
   https://script.google.com/macros/s/AKfy..../exec
   ```
   That becomes `SHEET_WEBHOOK_URL`.

> **"Anyone" is safe here.** Every request must contain the secret from step 3, and
> requests without it are rejected with `unauthorized`. Without "Anyone" the bot
> cannot reach the script at all, because it calls without a Google login.

## 5. Check it

Open the `/exec` URL in a browser. You should see:

```json
{"ok":true,"service":"partydekomiet-bot-storage"}
```

If you get an HTML error page instead, the deployment access is not set to "Anyone".

## 6. Put both values into the bot

Local (`.env`) and on Render (**Environment → Environment Variables**):

```
SHEET_WEBHOOK_URL=https://script.google.com/macros/s/AKfy..../exec
SHEET_SECRET=<the value from step 3>
```

## Re-deploying the script later

If `Code.gs` changes, use **Deploy → Manage deployments → edit (pencil) → Version: New
version → Deploy**. This keeps the same URL. Creating a *new deployment* instead gives a
new URL and you would have to update `SHEET_WEBHOOK_URL`.

## Good to know

- Reference photos from customers go into a private Drive folder
  `PartyDekoMiet Referenzbilder`, not into the Sheet. Only the file ID is stored.
- The bot batches its writes (one request every ~1.5 s) to stay inside Apps Script
  quotas. The WhatsApp login is the one exception — it is saved immediately, because
  losing it costs a QR scan.
- Never delete the `session` tab while the bot runs. That logs WhatsApp out.
