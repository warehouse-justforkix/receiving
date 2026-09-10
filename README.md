# JFK Receiving

Truck-receiving procedure and count sheets for the Just For Kix warehouse.
Live (once deployed): **https://warehouse-justforkix.github.io/receiving/**

Its own app and URL (like the Returns tracker), but it shares the JFK Supabase
project, so everyone signs in with the **same email and password as the Hub**.
Access is still per-app: an email must be invited here, in Admin, before it can
see any data.

## What it does

- **Count sheets** — one per PO. A sheet holds as many style-colors as you like,
  so `AC6833-Ivory` and `AC6833-Navy` can share a sheet or sit on separate ones.
- **Box-by-box counting** — every size row takes multiple box counts and adds them
  up into the counted total. The database hands out box numbers, so two people
  can count the same pallet at once.
- **SKU autocomplete** — start typing a style or color and pick from the catalog;
  the sizes for that style-color are added automatically, in youth-to-adult order.
  Sizes show NetSuite's real tokens (`XXL`, `A4XL`, `YM` …), not aliases.
- **Discrepancy tracking** — PO qty against counted qty per size, rolled up per
  sheet, with a discrepancies-only filter across every sheet you've ever saved.
- **Email drafts** — builds Karley's two formats (discrepancy request, or
  inventory-adjustment notice) and copies them with the bold intact for Gmail.
  Variance is always `counted − PO`, computed, never typed.
- **Comments and a change log** — nothing locks; every count, PO qty and bin edit
  is recorded with who changed it and when.
- **The procedure** — the 8-step instructional sheet, editable in-app by admins.
- **Notifications** — per-device web push for new comments and submitted sheets,
  using the same VAPID sender as the Hub.
- **Catalog auto-sync** — a server-side function pulls the item catalog from
  NetSuite nightly and on demand from the Admin tab, on any device.

## Stack

Static site, no build step: `index.html` + `style.css` + `app.js` + `config.js`,
talking straight to Supabase via `@supabase/supabase-js`. All authorization is
row-level security on the `recv_*` tables. Two Edge Functions
(`recv-push`, `recv-sync-catalog`). Hosted on GitHub Pages from `main`.

---

## Setup — do these in order

Everything below is click-through in a web browser plus two Terminal lines.
No Supabase CLI or Docker is needed (neither is installed on Karley's Mac).

### 1. Put the code on GitHub and turn on Pages

Terminal, one line (the repo name **must** be `receiving` — it becomes the URL):

```bash
cd ~/Documents/Claude/Receiving && gh repo create warehouse-justforkix/receiving --public --source=. --remote=origin --description "JFK Receiving — truck receiving procedure and count sheets (Supabase login)" --push
```

If `gh` refuses, do it in the browser instead:
https://github.com/organizations/warehouse-justforkix/repositories/new →
name `receiving` → **Public** → Create repository, then:

```bash
cd ~/Documents/Claude/Receiving && git remote add origin https://github.com/warehouse-justforkix/receiving.git && git push -u origin main
```

Then turn on Pages: https://github.com/warehouse-justforkix/receiving/settings/pages →
**Build and deployment** → Source: **Deploy from a branch** → Branch: **main**,
folder **/ (root)** → Save. The site appears at
https://warehouse-justforkix.github.io/receiving/ within a minute or two.

### 2. Create the database tables

1. Open https://supabase.com/dashboard/project/iptnlqfitvmoiofzrmvx/sql/new
2. Paste the **entire** contents of `db/setup.sql` and click **Run**.
3. You should see "Success. No rows returned." It is safe to run again later.

This seeds `karley@justforkix.com` as the admin.

### 3. Deploy the two Edge Functions (dashboard editor — no CLI)

For each of the two functions:

1. Open https://supabase.com/dashboard/project/iptnlqfitvmoiofzrmvx/functions
2. Click **Deploy a new function** → **Via Editor**.
3. Name it **exactly** as below (the name becomes its URL).
4. Delete the Hello-World template and paste the whole file.
5. **Turn "Verify JWT" OFF** for both — each one checks its own caller.
6. Click **Deploy function**.

| Name                | File to paste                                   |
|---------------------|-------------------------------------------------|
| `recv-push`         | `supabase/functions/recv-push/index.ts`         |
| `recv-sync-catalog` | `supabase/functions/recv-sync-catalog/index.ts` |

To change one later: Edge Functions → click it → **Deploy updates**.

### 4. Add the NetSuite secrets (for the catalog sync)

https://supabase.com/dashboard/project/iptnlqfitvmoiofzrmvx/functions/secrets →
**Add new secret**, six times. The five NetSuite values are in `~/jfk-mcp/.env`
on Karley's Mac (open it with TextEdit; copy each value exactly):

| Name                      | Value                                       |
|---------------------------|---------------------------------------------|
| `NETSUITE_ACCOUNT_ID`     | from `~/jfk-mcp/.env`                       |
| `NETSUITE_CONSUMER_KEY`   | from `~/jfk-mcp/.env`                       |
| `NETSUITE_CONSUMER_SECRET`| from `~/jfk-mcp/.env`                       |
| `NETSUITE_TOKEN_ID`       | from `~/jfk-mcp/.env`                       |
| `NETSUITE_TOKEN_SECRET`   | from `~/jfk-mcp/.env`                       |
| `RECV_SYNC_SECRET`        | any long random string — **write it down**, step 6 needs it |

The push function needs nothing new: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`
and `PUSH_TRIGGER_SECRET` already exist for the Hub.

> Secret values can't be read back once saved — the dashboard only ever shows
> that they exist. That is why `RECV_SYNC_SECRET` has to be written down now.

### 5. Wire the notifications (one SQL paste)

Nobody can read `PUSH_TRIGGER_SECRET` back to type it into a new webhook, so this
clones the Hub's existing, working push webhook onto the Receiving tables instead.

Open https://supabase.com/dashboard/project/iptnlqfitvmoiofzrmvx/sql/new, paste
the whole of `db/webhooks.sql`, click **Run**. Do this **after** step 3 — it points
at the `recv-push` function.

### 6. Schedule the nightly catalog sync

1. https://supabase.com/dashboard/project/iptnlqfitvmoiofzrmvx/integrations →
   **Cron** → **Enable** if asked → **Create job**.
2. Name: `recv-sync-catalog`. Schedule: `0 8 * * *` (3 am Central, daily).
3. Type: **Supabase Edge Function** → method **POST** → pick `recv-sync-catalog`.
4. Under HTTP Headers add one row:
   name `x-recv-sync-secret`, value = the `RECV_SYNC_SECRET` you wrote down.
5. Body: `{"months":18}`. Save.

Then run it once by hand so autocomplete has data: sign in to the app as admin →
**Admin → Catalog → Sync from NetSuite now**. The first full pull takes about a
minute and reports "ok — 19,000 SKUs …" when finished.

### 7. First sign-in and invites

- Open the site and click **Sign in** (not "Create an account") with your Hub
  email and password. Only someone who has never used the Hub or the Returns
  tracker creates an account.
- **Admin → Invite a teammate** for everyone else, **before** they first sign in,
  or they'll see "That email hasn't been invited to Receiving yet".
- **Admin → Email**: set who discrepancy drafts are addressed to. It starts blank
  on purpose so nothing is ever addressed to a guessed address.
- Each person taps **Turn on** on the notifications banner once per device.
  On iPhone, first add the site to the Home Screen (Share → Add to Home Screen)
  and open it from there — iOS only allows notifications for installed sites.

---

## Tests

```sh
node tools/email.test.mjs   # email wording against both reference examples (22 checks)
```

## Local preview

```sh
python3 -m http.server 8000   # then http://localhost:8000
```

(Needs a server: `app.js` is an ES module, so `file://` won't work.)

## Notes

- `tools/sync_catalog.py` is the original local version of the sync and is kept
  as a reference / emergency fallback. The live sync is the Edge Function.
- **Size tokens are messy.** NetSuite stores `XXL`, `A4XL`, `YXS`, `OSFA`, `S/M`,
  `X-Large`, `4XLT` and dozens more. The app shows the real token everywhere,
  including in emails — that's what Tristan reads against the PO. Admin → Size
  labels can add a display alias if one is ever wanted.
- The printable sheet still exists at
  `~/Documents/Claude/Claude Questions/_template-receiving-procedure.html`.
- Security note: Edge Function secrets are project-wide, so the NetSuite token is
  readable by any function in this Supabase project. Consider giving Receiving its
  own NetSuite integration record with a read-only role (Items + Purchase Orders).
