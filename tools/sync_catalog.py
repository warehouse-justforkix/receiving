#!/usr/bin/env python3
"""
Sync the receivable item catalog from NetSuite into Supabase (recv_catalog).

Scope: every inventory SKU that has appeared on a purchase order in the last
N months (default 18) — about 19k rows, ~2,300 styles. That is what the
warehouse actually receives, and it keeps the shared free-tier database small.

Credentials
  NetSuite : reused from ~/jfk-mcp/.env (OAuth 1.0 token-based auth)
  Supabase : tools/.env  ->  SUPABASE_SERVICE_KEY=...
             (or RECV_ADMIN_EMAIL + RECV_ADMIN_PASSWORD to sign in as an admin)

Usage
  python3 tools/sync_catalog.py            # full sync
  python3 tools/sync_catalog.py --months 6 # narrower window
  python3 tools/sync_catalog.py --dry-run  # parse and report, write nothing
"""
import argparse, base64, hashlib, hmac, json, os, random, string, sys, time, urllib.parse, urllib.request

HOME = os.path.expanduser("~")
NS_ENV = os.path.join(HOME, "jfk-mcp", ".env")
TOOLS_ENV = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
SUPABASE_URL = "https://iptnlqfitvmoiofzrmvx.supabase.co"


def load_env(path):
    out = {}
    if not os.path.exists(path):
        return out
    for line in open(path, encoding="utf-8"):
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        out[k.strip()] = v.strip().strip('"').strip("'")
    return out


# ---------------- NetSuite (OAuth1 TBA, HMAC-SHA256) ----------------
def pct(s):
    return urllib.parse.quote(str(s), safe="-._~")


def suiteql(env, q, limit=1000, offset=0):
    account = env["NETSUITE_ACCOUNT_ID"]
    host = account.lower().replace("_", "-")
    url = f"https://{host}.suitetalk.api.netsuite.com/services/rest/query/v1/suiteql"
    qs = {"limit": str(limit), "offset": str(offset)}

    oauth = {
        "oauth_consumer_key": env["NETSUITE_CONSUMER_KEY"],
        "oauth_token": env["NETSUITE_TOKEN_ID"],
        "oauth_signature_method": "HMAC-SHA256",
        "oauth_timestamp": str(int(time.time())),
        "oauth_nonce": "".join(random.choices(string.ascii_letters + string.digits, k=32)),
        "oauth_version": "1.0",
    }
    # every query param must take part in the signature
    allp = {**oauth, **qs}
    norm = "&".join(f"{pct(k)}={pct(allp[k])}" for k in sorted(allp))
    base = f"POST&{pct(url)}&{pct(norm)}"
    key = f'{pct(env["NETSUITE_CONSUMER_SECRET"])}&{pct(env["NETSUITE_TOKEN_SECRET"])}'
    oauth["oauth_signature"] = base64.b64encode(
        hmac.new(key.encode(), base.encode(), hashlib.sha256).digest()
    ).decode()

    auth = "OAuth realm=\"%s\", %s" % (
        account.upper(),
        ", ".join(f'{pct(k)}="{pct(v)}"' for k, v in sorted(oauth.items())),
    )
    req = urllib.request.Request(
        f"{url}?{urllib.parse.urlencode(qs)}",
        data=json.dumps({"q": q}).encode(),
        method="POST",
        headers={
            "Authorization": auth,
            "Content-Type": "application/json",
            "Prefer": "transient",
        },
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read().decode())


# ---------------- SKU parsing ----------------
def parse_sku(sku, style):
    """
    SKUs are {style}-{color}-{size}, with shoes adding a width:
    AC6776-Fuchsia-XS, TB135-W-XL, 2037C-LightPink-Y8-M, V725C-Caramel-12-M.
    The style comes from NetSuite's parent field, so only color/size need splitting:
    the size is the last segment, except for a trailing single-letter width
    (M/N/W/X) which belongs with it.
    """
    if not style or not sku.startswith(style + "-"):
        return None
    rest = sku[len(style) + 1:]
    parts = rest.split("-")
    if len(parts) < 2:
        return {"style": style, "color": rest or None, "size": "OS"}
    if len(parts) >= 3 and len(parts[-1]) == 1 and parts[-1].upper() in ("M", "N", "W", "X"):
        size = "-".join(parts[-2:])          # 'Y8-M' — size plus width
        color = "-".join(parts[:-2])
    else:
        size = parts[-1]
        color = "-".join(parts[:-1])
    return {"style": style, "color": color or None, "size": size}


def fetch_catalog(env, months, verbose=True):
    q = f"""
      SELECT DISTINCT i.itemid AS sku, BUILTIN.DF(i.parent) AS style
        FROM transaction t
        JOIN transactionline tl ON tl.transaction = t.id
        JOIN item i ON i.id = tl.item
       WHERE t.type = 'PurchOrd'
         AND t.trandate > ADD_MONTHS(CURRENT_DATE, -{int(months)})
         AND tl.itemtype = 'InvtPart'
         AND i.parent IS NOT NULL
       ORDER BY i.itemid
    """
    rows, offset, skipped = [], 0, 0
    while True:
        page = suiteql(env, q, limit=1000, offset=offset)
        items = page.get("items", [])
        for it in items:
            p = parse_sku(it["sku"], it.get("style"))
            if not p:
                skipped += 1
                continue
            rows.append({
                "sku": it["sku"],
                "style": p["style"],
                "color": p["color"],
                "size": p["size"],
                "style_color": f'{p["style"]}-{p["color"]}' if p["color"] else p["style"],
            })
        if verbose:
            print(f"  fetched {len(rows)} rows (offset {offset})", flush=True)
        if not page.get("hasMore"):
            break
        offset += 1000
    return rows, skipped


# ---------------- Supabase ----------------
def supabase_token(cfg):
    if cfg.get("SUPABASE_SERVICE_KEY"):
        return cfg["SUPABASE_SERVICE_KEY"], cfg["SUPABASE_SERVICE_KEY"]
    email, pw = cfg.get("RECV_ADMIN_EMAIL"), cfg.get("RECV_ADMIN_PASSWORD")
    anon = cfg.get("SUPABASE_ANON_KEY")
    if not (email and pw and anon):
        sys.exit("tools/.env needs SUPABASE_SERVICE_KEY, or "
                 "RECV_ADMIN_EMAIL + RECV_ADMIN_PASSWORD + SUPABASE_ANON_KEY")
    req = urllib.request.Request(
        f"{SUPABASE_URL}/auth/v1/token?grant_type=password",
        data=json.dumps({"email": email, "password": pw}).encode(),
        headers={"apikey": anon, "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode())["access_token"], anon


def upsert(rows, token, apikey, chunk=500):
    done = 0
    for i in range(0, len(rows), chunk):
        batch = rows[i:i + chunk]
        req = urllib.request.Request(
            f"{SUPABASE_URL}/rest/v1/recv_catalog?on_conflict=sku",
            data=json.dumps(batch).encode(),
            method="POST",
            headers={
                "apikey": apikey,
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
                "Prefer": "resolution=merge-duplicates,return=minimal",
            },
        )
        with urllib.request.urlopen(req, timeout=120):
            done += len(batch)
        print(f"  upserted {done}/{len(rows)}", flush=True)
    return done


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--months", type=int, default=18)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    ns = load_env(NS_ENV)
    missing = [k for k in ("NETSUITE_ACCOUNT_ID", "NETSUITE_CONSUMER_KEY",
                           "NETSUITE_CONSUMER_SECRET", "NETSUITE_TOKEN_ID",
                           "NETSUITE_TOKEN_SECRET") if not ns.get(k)]
    if missing:
        sys.exit(f"missing from {NS_ENV}: {', '.join(missing)}")

    print(f"NetSuite: pulling PO items from the last {a.months} months...")
    rows, skipped = fetch_catalog(ns, a.months)
    styles = {r["style"] for r in rows}
    sizes = {r["size"] for r in rows}
    print(f"\n{len(rows)} SKUs | {len(styles)} styles | {len(sizes)} distinct size tokens"
          f" | {skipped} unparseable")

    if a.dry_run:
        print("\n--dry-run: nothing written. Sample:")
        for r in rows[:8]:
            print("  ", r)
        return

    cfg = load_env(TOOLS_ENV)
    cfg.setdefault("SUPABASE_ANON_KEY", "")
    token, apikey = supabase_token(cfg)
    print("\nSupabase: upserting recv_catalog...")
    print(f"done — {upsert(rows, token, apikey)} rows")


if __name__ == "__main__":
    main()
