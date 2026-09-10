// Sends JFK Receiving push notifications.
// Reuses the same VAPID key pair as the Warehouse Hub's push-message function,
// so no new secrets are needed in this Supabase project.
//
// Deploy:  supabase functions deploy recv-push
// Secrets already set for the Hub and reused here:
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, PUSH_TRIGGER_SECRET
//
// Call it from a Database Webhook on insert into recv_comments, with header
//   x-push-secret: <PUSH_TRIGGER_SECRET>
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

webpush.setVapidDetails(
  Deno.env.get("VAPID_SUBJECT") || "mailto:karley@justforkix.com",
  Deno.env.get("VAPID_PUBLIC_KEY")!,
  Deno.env.get("VAPID_PRIVATE_KEY")!,
);

const APP_URL = "https://warehouse-justforkix.github.io/receiving/";

Deno.serve(async (req) => {
  if (req.headers.get("x-push-secret") !== Deno.env.get("PUSH_TRIGGER_SECRET")) {
    return new Response("forbidden", { status: 403 });
  }

  const payload = await req.json().catch(() => ({}));
  // Supabase database webhooks send { type, table, record, old_record }
  const table = payload.table ?? payload.source;
  const rec = payload.record ?? payload;

  let title = "JFK Receiving";
  let body = "";
  let skipPersonId: string | null = null;

  if (table === "recv_comments") {
    const [{ data: sheet }, { data: author }] = await Promise.all([
      admin.from("recv_sheets").select("title, po_number").eq("id", rec.sheet_id).maybeSingle(),
      admin.from("recv_people").select("name").eq("id", rec.author_id).maybeSingle(),
    ]);
    title = `${author?.name ?? "Someone"} commented on PO# ${sheet?.po_number ?? "?"}`;
    body = String(rec.body ?? "").slice(0, 140);
    skipPersonId = rec.author_id ?? null;   // don't notify the author of their own comment
  } else if (table === "recv_sheets" && rec.status === "submitted") {
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

  const note = JSON.stringify({ title, body, url: APP_URL, tag: rec.sheet_id ?? undefined });
  let sent = 0;
  const stale: string[] = [];

  await Promise.all((subs ?? []).map(async (s) => {
    try {
      await webpush.sendNotification(s.subscription, note);
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number })?.statusCode;
      if (code === 404 || code === 410) stale.push(s.endpoint);   // device gone
    }
  }));

  if (stale.length) {
    await admin.from("recv_push_subscriptions").delete().in("endpoint", stale);
  }

  return new Response(JSON.stringify({ sent, pruned: stale.length }), {
    headers: { "content-type": "application/json" },
  });
});
