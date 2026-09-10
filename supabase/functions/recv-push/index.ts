// Sends JFK Receiving push notifications.
// Reuses the same VAPID key pair as the Warehouse Hub's push-message function,
// so no new secrets are needed in this Supabase project.
//
// Deploy from the Supabase dashboard (Edge Functions -> Deploy a new function ->
// Via Editor), name it exactly `recv-push`, and turn "Verify JWT" OFF — the
// shared x-push-secret header is the auth for this endpoint.
//
// Secrets read here, all already set for the Hub:
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, PUSH_TRIGGER_SECRET
//
// Called by the Database Webhooks that db/webhooks.sql installs on
// recv_comments (insert) and recv_sheets (status change).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

webpush.setVapidDetails(
  "mailto:karley@justforkix.com",
  Deno.env.get("VAPID_PUBLIC_KEY")!,
  Deno.env.get("VAPID_PRIVATE_KEY")!,
);

const APP_URL = "https://warehouse-justforkix.github.io/receiving/";

Deno.serve(async (req) => {
  if (req.headers.get("x-push-secret") !== Deno.env.get("PUSH_TRIGGER_SECRET")) {
    return new Response("forbidden", { status: 403 });
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
    // only on the transition INTO submitted — never on later edits to a submitted sheet
    if (rec.status !== "submitted" || old?.status === "submitted") {
      return new Response(JSON.stringify({ skipped: true, reason: "not a submit transition" }), {
        headers: { "content-type": "application/json" },
      });
    }
    title = `Sheet submitted — PO# ${rec.po_number ?? "?"}`;
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
