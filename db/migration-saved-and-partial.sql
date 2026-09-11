-- ============================================================
-- JFK Receiving - migration
--   1. a style-color can be marked saved (counts frozen) on a sheet
--   2. a sheet can be Partially Received
-- Paste into the Supabase SQL editor and Run. Safe to re-run.
-- ============================================================

-- 1 ----------------------------------------------------------
alter table recv_sheet_groups
  add column if not exists saved boolean not null default false;

-- 2 ----------------------------------------------------------
-- The status CHECK is auto-named, so find it rather than guess.
do $$
declare c text;
begin
  select conname into c
    from pg_constraint
   where conrelid = 'recv_sheets'::regclass
     and contype = 'c'
     and pg_get_constraintdef(oid) ilike '%status%';
  if c is not null then
    execute format('alter table recv_sheets drop constraint %I', c);
  end if;
end $$;

alter table recv_sheets
  add constraint recv_sheets_status_check
  check (status in ('counting','submitted','partial','closed'));

-- confirm ----------------------------------------------------
select
  (select count(*) from information_schema.columns
    where table_name='recv_sheet_groups' and column_name='saved') as saved_column_added,
  (select pg_get_constraintdef(oid) from pg_constraint
    where conname='recv_sheets_status_check') as status_values_allowed;
