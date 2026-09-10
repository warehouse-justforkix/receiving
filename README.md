# JFK Receiving

Truck-receiving procedure and count sheets for the Just For Kix warehouse.
Live: **https://warehouse-justforkix.github.io/receiving/**

Its own app and URL (like the Returns tracker), but it shares the JFK Supabase
project, so everyone signs in with the **same email and password as the Hub**.
Access is still per-app: an email must be invited here, in Admin, before it can
see any data.

## What it does

- **Count sheets** — one per PO. A sheet holds as many style-colors as you like,
  so `AC6833-Ivory` and `AC6833-Navy` can share a sheet or sit on separate ones.
- **Box-by-box counting** — every size row takes multiple box counts and adds them
  up into the counted total, so you can count a carton at a time instead of doing
  the arithmetic in your head.
- **SKU autocomplete** — start typing a style or color and pick from the catalog;
  the sizes for that style-color are added automatically, in youth-to-adult order.
- **Discrepancy tracking** — PO qty against counted qty per size, rolled up per
  sheet, with a discrepancies-only filter across every sheet you've ever saved.
- **Email drafts** — builds Karley's two formats (discrepancy request, or
  inventory-adjustment notice) and copies them with the bold intact for Gmail.
- **Comments and a change log** — nothing locks; every count, PO qty and bin edit
  is recorded with who changed it and when.
- **The procedure** — the 8-step instructional sheet, editable in-app by admins.
- **Notifications** — per-device web push, same VAPID sender as the Hub, for new
  comments and submitted sheets.

## Stack

Static site, no build step: `index.html` + `style.css` + `app.js` + `config.js`,
talking straight to Supabase via `@supabase/supabase-js` (ESM from esm.sh).
All authorization is row-level security on the `recv_*` tables. Hosted on GitHub
Pages from `main`.

## Setup

1. **Database** — paste `db/setup.sql` into the Supabase SQL editor (project
   `iptnlqfitvmoiofzrmvx`) and run it. Safe to re-run. It seeds
   `karley@justforkix.com` as the admin.
2. **Sign in** — open the site, "Create your account" with an invited email, set
   a password. Karley invites everyone else from the Admin tab.
3. **Set the email recipient** — Admin → the `email_to` setting starts blank on
   purpose so nothing is ever addressed to a guessed address.
4. **Catalog** — run the sync so autocomplete has something to match:

```sh
python3 tools/sync_catalog.py            # ~19k SKUs from the last 18 months
python3 tools/sync_catalog.py --dry-run  # parse and report, write nothing
```

   It reuses the NetSuite credentials already in `~/jfk-mcp/.env`, and needs
   `tools/.env` (gitignored) with either `SUPABASE_SERVICE_KEY=...` or
   `RECV_ADMIN_EMAIL` + `RECV_ADMIN_PASSWORD` + `SUPABASE_ANON_KEY`.
   It has to run on Karley's Mac — NetSuite isn't reachable from the browser.

5. **Notifications** — each person taps "Turn on" on the banner (or Admin →
   Notifications) once per device. Sending needs the edge function deployed:

```sh
supabase functions deploy recv-push
```

   It reuses the Hub's existing `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` /
   `PUSH_TRIGGER_SECRET` secrets — nothing new to set. Then add a Supabase
   **Database Webhook** on `insert` into `recv_comments` (and `update` on
   `recv_sheets`) pointing at the function, with header
   `x-push-secret: <PUSH_TRIGGER_SECRET>`.

   iPhone note: iOS only allows web push once the site is added to the home
   screen, so install it from Safari's Share sheet first.

## Tests

```sh
node tools/email.test.mjs   # email wording against both reference examples
```

## Local preview

```sh
python3 -m http.server 8000   # then http://localhost:8000
```

(Needs a server: `app.js` is an ES module, so `file://` won't work.)

## Notes

- **Size tokens are messy.** NetSuite stores `XXL`, `A4XL`, `YXS`, `OSFA`,
  `S/M`, `X-Large`, `4XLT` and dozens more — 59 distinct tokens in a 1,000-row
  sample. The app shows the real token by default. Admin → Size labels adds a
  display alias (e.g. `XXL` → `2XL`) where you'd rather see something else.
- **The print sheet still exists** at
  `~/Documents/Claude/Claude Questions/_template-receiving-procedure.html`
  if a paper count sheet is ever needed.
