-- ============================================================
-- JFK Receiving - per-size received mark
-- Lets someone explicitly mark each size Received or Not received
-- when a sheet is Partially Received.
--   null  = not decided yet
--   true  = received
--   false = not received
-- Paste into the Supabase SQL editor and Run. Safe to re-run.
-- ============================================================

alter table recv_sheet_lines
  add column if not exists received boolean;

-- log changes to it like every other line edit
create or replace function public.recv_log_line_change() returns trigger
  language plpgsql security definer set search_path = public as $$
declare actor uuid := public.recv_me();
begin
  if new.po_qty is distinct from old.po_qty then
    insert into recv_audit (sheet_id,line_id,entity,field,old_value,new_value,actor_id)
      values (new.sheet_id,new.id,'line','po_qty',old.po_qty::text,new.po_qty::text,actor);
  end if;
  if new.counted_qty is distinct from old.counted_qty then
    insert into recv_audit (sheet_id,line_id,entity,field,old_value,new_value,actor_id)
      values (new.sheet_id,new.id,'line','counted_qty',old.counted_qty::text,new.counted_qty::text,actor);
  end if;
  if new.received is distinct from old.received then
    insert into recv_audit (sheet_id,line_id,entity,field,old_value,new_value,actor_id)
      values (new.sheet_id,new.id,'line','received',old.received::text,new.received::text,actor);
  end if;
  if new.shelved is distinct from old.shelved then
    insert into recv_audit (sheet_id,line_id,entity,field,old_value,new_value,actor_id)
      values (new.sheet_id,new.id,'line','shelved',old.shelved::text,new.shelved::text,actor);
  end if;
  return new;
end $$;

select count(*) as received_column_added
  from information_schema.columns
 where table_name = 'recv_sheet_lines' and column_name = 'received';
