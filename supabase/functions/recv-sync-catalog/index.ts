// Syncs the receivable item catalog from NetSuite into recv_catalog, server-side,
// so it runs on a schedule and from the Admin "Sync now" button on any device.
//
// Port of tools/sync_catalog.py (verified against live NetSuite). Same query,
// same SKU parsing, same OAuth 1.0 HMAC-SHA256 token-based auth.
//
// Deploy from the Supabase dashboard (Edge Functions -> Deploy a new function ->
// Via Editor), name it exactly `recv-sync-catalog`, and turn "Verify JWT" OFF -
// this function checks authorization itself (see below).
//
// Secrets to set (Edge Functions -> Secrets):
//   NETSUITE_ACCOUNT_ID, NETSUITE_CONSUMER_KEY, NETSUITE_CONSUMER_SECRET,
//   NETSUITE_TOKEN_ID, NETSUITE_TOKEN_SECRET       (copied from ~/jfk-mcp/.env)
//   RECV_SYNC_SECRET                                (any long random string you choose)
//
// Two accepted callers:
//   - the schedule (Supabase Cron): header  x-recv-sync-secret: <RECV_SYNC_SECRET>
//   - an admin in the app: the normal Supabase JWT; we look the user up in recv_people.
//
// Responds 202 immediately and does the work in the background (EdgeRuntime.waitUntil),
// so the caller's timeout can't cut the sync short. Progress is checkpointed in
// recv_settings so an interrupted run resumes instead of starting over.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

const CORS = {
  "access-control-allow-origin": "https://warehouse-justforkix.github.io",
  "access-control-allow-headers": "authorization, apikey, content-type, x-client-info, x-recv-sync-secret",
  "access-control-allow-methods": "POST, OPTIONS",
};
const JSONH = { ...CORS, "content-type": "application/json" };

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const need = (k: string) => {
  const v = Deno.env.get(k);
  if (!v) throw new Error(`missing secret ${k}`);
  return v;
};

/* ---------------- OAuth 1.0 (TBA) - must match the Python byte-for-byte ---------------- */
// RFC 3986: equals Python urllib.parse.quote(s, safe="-._~"). encodeURIComponent alone
// leaves ! ' ( ) * unescaped and produces a different signature.
const pct = (s: string | number) =>
  encodeURIComponent(String(s)).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

async function hmacSha256B64(key: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg));
  return btoa(String.fromCharCode(...new Uint8Array(mac)));
}

function nonce(n = 32) {
  const a = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return [...bytes].map((b) => a[b % a.length]).join("");
}

async function suiteql(q: string, limit = 1000, offset = 0) {
  const account = need("NETSUITE_ACCOUNT_ID");
  const host = account.toLowerCase().replace(/_/g, "-");
  const url = `https://${host}.suitetalk.api.netsuite.com/services/rest/query/v1/suiteql`;
  const qs: Record<string, string> = { limit: String(limit), offset: String(offset) };

  const oauth: Record<string, string> = {
    oauth_consumer_key: need("NETSUITE_CONSUMER_KEY"),
    oauth_token: need("NETSUITE_TOKEN_ID"),
    oauth_signature_method: "HMAC-SHA256",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_nonce: nonce(),
    oauth_version: "1.0",
  };
  // every query param takes part in the signature; sign the bare URL, not URL?limit=...
  const allp = { ...oauth, ...qs };
  const norm = Object.keys(allp).sort().map((k) => `${pct(k)}=${pct(allp[k])}`).join("&");
  const base = `POST&${pct(url)}&${pct(norm)}`;
  const key = `${pct(need("NETSUITE_CONSUMER_SECRET"))}&${pct(need("NETSUITE_TOKEN_SECRET"))}`;
  oauth.oauth_signature = await hmacSha256B64(key, base);

  const auth = `OAuth realm="${account.toUpperCase()}", ` +
    Object.keys(oauth).sort().map((k) => `${pct(k)}="${pct(oauth[k])}"`).join(", ");

  const res = await fetch(`${url}?${new URLSearchParams(qs)}`, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json", Prefer: "transient" },
    body: JSON.stringify({ q }),
  });
  if (!res.ok) throw new Error(`NetSuite ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return await res.json() as { items: Array<{ sku: string; style: string | null }>; hasMore: boolean };
}

/* ---------------- SKU parsing (same rules as the Python) ---------------- */
function parseSku(sku: string, style: string | null) {
  if (!style || !sku.startsWith(style + "-")) return null;
  const rest = sku.slice(style.length + 1);
  const parts = rest.split("-");
  if (parts.length < 2) return { style, color: rest || null, size: "OS" };
  let size: string, color: string;
  const last = parts[parts.length - 1];
  if (parts.length >= 3 && last.length === 1 && "MNWX".includes(last.toUpperCase())) {
    size = parts.slice(-2).join("-");           // 'Y8-M' - shoe size plus width
    color = parts.slice(0, -2).join("-");
  } else {
    size = last;
    color = parts.slice(0, -1).join("-");
  }
  return { style, color: color || null, size };
}

const QUERY = (months: number) => `
  SELECT DISTINCT i.itemid AS sku, BUILTIN.DF(i.parent) AS style
    FROM transaction t
    JOIN transactionline tl ON tl.transaction = t.id
    JOIN item i ON i.id = tl.item
   WHERE t.type = 'PurchOrd'
     AND t.trandate > ADD_MONTHS(CURRENT_DATE, -${Math.max(1, Math.min(60, months | 0))})
     AND tl.itemtype = 'InvtPart'
     AND i.parent IS NOT NULL
   ORDER BY i.itemid`;

/* ---------------- settings helpers ---------------- */
async function getSetting(key: string) {
  const { data } = await admin.from("recv_settings").select("value").eq("key", key).maybeSingle();
  return data?.value ?? null;
}
async function setSettings(kv: Record<string, string>) {
  const now = new Date().toISOString();
  await admin.from("recv_settings").upsert(
    Object.entries(kv).map(([key, value]) => ({ key, value, updated_at: now })),
    { onConflict: "key" });
}

/* ---------------- the sync itself ---------------- */
const WALL_BUDGET_MS = 120_000;   // stay under the 150s free-plan wall clock; resume next run

async function runSync(months: number) {
  const started = Date.now();
  const now = new Date().toISOString();
  let offset = Number((await getSetting("catalog_sync_offset")) ?? 0) || 0;
  let done = Number((await getSetting("catalog_sync_partial")) ?? 0) || 0;
  await setSettings({ catalog_sync_status: `running from offset ${offset}` });

  try {
    while (true) {
      const page = await suiteql(QUERY(months), 1000, offset);
      const rows = page.items.map((it) => {
        const p = parseSku(it.sku, it.style);
        return p && {
          sku: it.sku, style: p.style, color: p.color, size: p.size,
          style_color: p.color ? `${p.style}-${p.color}` : p.style,
          synced_at: now,
        };
      }).filter(Boolean);

      for (let i = 0; i < rows.length; i += 500) {
        const { error } = await admin.from("recv_catalog")
          .upsert(rows.slice(i, i + 500), { onConflict: "sku" });
        if (error) throw new Error(`upsert: ${error.message}`);
      }
      done += rows.length;

      if (!page.hasMore) break;
      offset += 1000;
      await setSettings({ catalog_sync_offset: String(offset), catalog_sync_partial: String(done),
                          catalog_sync_status: `running: ${done} SKUs so far` });

      if (Date.now() - started > WALL_BUDGET_MS) {
        await setSettings({ catalog_sync_status: `paused at ${done} SKUs - will resume on the next run` });
        return;
      }
    }

    // full pass complete: drop SKUs that haven't been on a PO for 30+ days of runs,
    // rebuild the style-color list the autocomplete searches, and stamp the run.
    const cutoff = new Date(Date.now() - 30 * 86400_000).toISOString();
    await admin.from("recv_catalog").delete().lt("synced_at", cutoff);
    const { data: styles } = await admin.rpc("recv_refresh_styles");
    await setSettings({
      catalog_sync_offset: "0",
      catalog_sync_partial: "0",
      catalog_synced_at: new Date().toISOString(),
      catalog_sync_status: `ok - ${done} SKUs, ${styles ?? "?"} style-colors, ${Math.round((Date.now() - started) / 1000)}s`,
    });
  } catch (e) {
    await setSettings({
      catalog_sync_status: `failed: ${String((e as Error)?.message ?? e).slice(0, 220)}`,
    });
  }
}

/* ---------------- HTTP ---------------- */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return new Response("method not allowed", { status: 405, headers: CORS });

  // caller 1: the schedule, by shared secret
  const cronOk = !!Deno.env.get("RECV_SYNC_SECRET") &&
    req.headers.get("x-recv-sync-secret") === Deno.env.get("RECV_SYNC_SECRET");

  // caller 2: a signed-in Receiving admin, by their JWT
  let adminOk = false;
  if (!cronOk) {
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (jwt) {
      const { data: { user } } = await admin.auth.getUser(jwt);
      if (user) {
        const { data: p } = await admin.from("recv_people")
          .select("is_admin").eq("auth_user_id", user.id).maybeSingle();
        adminOk = !!p?.is_admin;
      }
    }
  }
  if (!cronOk && !adminOk) return new Response("forbidden", { status: 403, headers: CORS });

  const body = await req.json().catch(() => ({}));
  const months = Number(body?.months) || 18;

  const status = (await getSetting("catalog_sync_status")) ?? "";
  if (status.startsWith("running")) {
    return new Response(JSON.stringify({ started: false, status }), { status: 200, headers: JSONH });
  }

  EdgeRuntime.waitUntil(runSync(months));
  return new Response(JSON.stringify({ started: true, months }), { status: 202, headers: JSONH });
});
