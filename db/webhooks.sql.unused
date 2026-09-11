-- ============================================================
-- JFK Receiving — wire push notifications
-- Run this AFTER the recv-push Edge Function is deployed.
--
-- Edge Function secret values are write-only in Supabase, so nobody can read
-- PUSH_TRIGGER_SECRET back to type it into a new webhook. Instead this clones
-- the Hub's already-working push webhook (URL, headers and secret included),
-- re-points it at recv-push, and attaches it to the Receiving tables.
-- Same trick the Hub's db/costume-timer.sql uses. Safe to re-run.
-- ============================================================

do $$
declare
  def text;
begin
  select pg_get_triggerdef(t.oid) into def
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_proc p on p.oid = t.tgfoid
   where c.relname = 'messages' and n.nspname = 'public'
     and not t.tgisinternal
     and p.proname = 'http_request'      -- Supabase Database Webhook function
   limit 1;

  if def is null then
    raise exception 'No Database Webhook found on public.messages. Create the two Receiving webhooks by hand in Database -> Webhooks (see README).';
  end if;

  -- point the copy at the Receiving function instead of the Hub's
  def := regexp_replace(def, '/functions/v1/push-message', '/functions/v1/recv-push');

  -- 1) new comment -> notify everyone but the author
  execute 'drop trigger if exists recv_comments_push on public.recv_comments';
  execute regexp_replace(
            regexp_replace(def, '^CREATE TRIGGER (\S+|"[^"]*")', 'CREATE TRIGGER recv_comments_push'),
            ' ON public\.messages ', ' ON public.recv_comments ');

  -- 2) sheet status changes -> notify (function itself only pushes on 'submitted').
  --    Fires only when status actually changes, so box counts (which bump
  --    updated_at on every keystroke) never reach the function at all.
  execute 'drop trigger if exists recv_sheets_push on public.recv_sheets';
  execute regexp_replace(
            regexp_replace(
              regexp_replace(
                regexp_replace(def, '^CREATE TRIGGER (\S+|"[^"]*")', 'CREATE TRIGGER recv_sheets_push'),
                ' ON public\.messages ', ' ON public.recv_sheets '),
              'AFTER INSERT', 'AFTER UPDATE OF status'),
            ' FOR EACH ROW EXECUTE FUNCTION',
            ' FOR EACH ROW WHEN (old.status IS DISTINCT FROM new.status) EXECUTE FUNCTION');

  raise notice 'Receiving push webhooks installed on recv_comments and recv_sheets.';
end $$;
