// Sends JFK Receiving push notifications.
// Reuses the same VAPID key pair as the Warehouse Hub's push-message function,
// so no new secrets are needed in this Supabase project.
//
// Deploy from the Supabase dashboard (Edge Functions -> Deploy a new function ->
// Via Editor), name it exactly `recv-push`, and turn "Verify JWT" OFF - the
// shared x-push-secret header is the auth for this endpoint.
//
// Secrets read here, all already set for the Hub:
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, and RECV_PUSH_SECRET
//   (PUSH_TRIGGER_SECRET from the Hub is also accepted)
//
// Called by the Database Webhooks that db/webhooks.sql installs on
// recv_comments (insert) and recv_sheets (status change).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// Configured lazily inside the handler: calling setVapidDetails at module
// scope with a missing key throws, which Supabase reports only as BOOT_ERROR.
let vapidReady = false;
function initVapid(): string | null {
  if (vapidReady) return null;
  const pub = Deno.env.get("VAPID_PUBLIC_KEY");
  const priv = Deno.env.get("VAPID_PRIVATE_KEY");
  if (!pub || !priv) {
    return "missing secret: " + (!pub ? "VAPID_PUBLIC_KEY " : "") + (!priv ? "VAPID_PRIVATE_KEY" : "");
  }
  webpush.setVapidDetails("mailto:karley@justforkix.com", pub, priv);
  vapidReady = true;
  return null;
}

const APP_URL = "https://warehouse-justforkix.github.io/receiving/";

Deno.serve(async (req) => {
  // Accept either our own secret (set by Karley, readable by her) or the Hub's
  // existing PUSH_TRIGGER_SECRET, so this works whether or not the Hub webhook
  // could be cloned.
  const given = req.headers.get("x-push-secret");
  const mine = Deno.env.get("RECV_PUSH_SECRET");
  const hub  = Deno.env.get("PUSH_TRIGGER_SECRET");
  const okSecret = (!!mine && given === mine) || (!!hub && given === hub);
  if (!okSecret) {
    return new Response("forbidden", { status: 403 });
  }

  const vapidErr = initVapid();
  if (vapidErr) {
    return new Response(JSON.stringify({ error: vapidErr }), {
      status: 500, headers: { "content-type": "application/json" },
    });
  }

  const payload = await req.json().catch(() => ({}));
  // Supabase database webhooks send { type, table, schema, record, old_record }
  const table = payload.table ?? payload.source;
  const rec = payload.record ?? payload;
  const old = payload.old_record ?? null;

  let title = "JFK Receiving";
  let body = "";
  let skipPersonId: string | null = null;

  if (table === "recv_comments") {
    const [{ data: sheet }, { data: author }] = await Promise.all([
      admin.from("recv_sheets").select("title, po_number").eq("id", rec.sheet_id).maybeSingle(),
      rec.author_id
        ? admin.from("recv_people").select("name").eq("id", rec.author_id).maybeSingle()
        : Promise.resolve({ data: null }),
    ]);
    title = `${author?.name ?? "Someone"} commented on PO# ${sheet?.po_number ?? "?"}`;
    body = String(rec.body ?? "").slice(0, 140);
    skipPersonId = rec.author_id ?? null;   // don't notify the author of their own comment
  } else if (table === "recv_sheets") {
    // only on the transition INTO submitted - never on later edits to a submitted sheet
    if (rec.status !== "submitted" || old?.status === "submitted") {
      return new Response(JSON.stringify({ skipped: true, reason: "not a submit transition" }), {
        headers: { "content-type": "application/json" },
      });
    }
    title = `Sheet submitted - PO# ${rec.po_number ?? "?"}`;
    body = String(rec.title ?? "").slice(0, 140);
  } else if (payload.title) {
    title = String(payload.title);
    body = String(payload.body ?? "").slice(0, 140);
  } else {
    return new Response(JSON.stringify({ skipped: true, table }), {
      headers: { "content-type": "application/json" },
    });
  }

  let q = admin.from("recv_push_subscriptions").select("id, endpoint, subscription, person_id");
  if (skipPersonId) q = q.neq("person_id", skipPersonId);
  const { data: subs, error } = await q;
  if (error) return new Response(error.message, { status: 500 });

  // tag groups notifications per sheet; sw.js sets renotify so each one still alerts
  const note = JSON.stringify({ title, body, url: APP_URL, tag: rec.sheet_id ?? rec.id ?? undefined });
  let sent = 0;
  const errors: string[] = [];
  const stale: string[] = [];

  await Promise.all((subs ?? []).map(async (s) => {
    try {
      await webpush.sendNotification(s.subscription, note);
      sent++;
    } catch (e) {
      const err = e as { statusCode?: number; body?: string; message?: string };
      errors.push(`${err.statusCode ?? "?"}: ${(err.body || err.message || "").slice(0, 200)}`);
      if (err.statusCode === 404 || err.statusCode === 410) stale.push(s.endpoint);   // device gone
    }
  }));

  if (stale.length) {
    await admin.from("recv_push_subscriptions").delete().in("endpoint", stale);
  }

  return new Response(JSON.stringify({ sent, pruned: stale.length, errors }), {
    headers: { "content-type": "application/json" },
  });
});
