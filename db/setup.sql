-- ============================================================
-- JFK Receiving — schema
-- Shared Supabase project (iptnlqfitvmoiofzrmvx). All objects are
-- prefixed recv_ so they can't collide with the Hub or Returns app.
-- Paste into the Supabase SQL editor. Safe to re-run.
-- ============================================================

-- ---------- membership (mirrors the returns_* pattern) ----------
create table if not exists recv_invited_emails (
  email      text primary key,
  name       text,
  is_admin   boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists recv_people (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  email        text unique,
  auth_user_id uuid unique references auth.users(id) on delete cascade,
  is_admin     boolean not null default false,
  color        text,
  created_at   timestamptz not null default now()
);

create or replace function public.recv_is_member() returns boolean
  language sql security definer stable set search_path = public
  as $$ select exists (select 1 from recv_people where auth_user_id = auth.uid()) $$;

create or replace function public.recv_is_admin() returns boolean
  language sql security definer stable set search_path = public
  as $$ select coalesce((select is_admin from recv_people where auth_user_id = auth.uid()), false) $$;

create or replace function public.recv_me() returns uuid
  language sql security definer stable set search_path = public
  as $$ select id from recv_people where auth_user_id = auth.uid() $$;

-- On first sign-in, promote an invited email into a person row.
create or replace function public.recv_handle_login() returns void
  language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  e   text := lower(coalesce((select email from auth.users where id = auth.uid()), ''));
  inv recv_invited_emails;
begin
  if uid is null or e = '' then return; end if;
  select * into inv from recv_invited_emails where lower(email) = e;
  if not found then return; end if;                    -- un-invited: no data access
  if exists (select 1 from recv_people where auth_user_id = uid) then
    update recv_people set is_admin = inv.is_admin, email = e where auth_user_id = uid;
  else
    insert into recv_people (name, email, auth_user_id, is_admin, color)
      values (coalesce(inv.name, split_part(e,'@',1)), e, uid, inv.is_admin,
              '#' || substr(md5(e), 1, 6))
      on conflict (email) do update
        set auth_user_id = uid, is_admin = inv.is_admin;
  end if;
end $$;

-- ---------- item catalog (synced from NetSuite) ----------
create table if not exists recv_catalog (
  sku          text primary key,
  style        text not null,
  color        text,
  size         text,
  style_color  text not null,
  last_po_date date,
  synced_at    timestamptz not null default now()
);
create index if not exists recv_catalog_style_color_idx on recv_catalog (style_color);
create index if not exists recv_catalog_sku_trgm_idx    on recv_catalog (sku text_pattern_ops);

-- Optional display aliases for size tokens (e.g. XXL shown as 2XL).
-- Empty by default: the real NetSuite token is used unless an alias exists.
create table if not exists recv_size_labels (
  ns_size       text primary key,
  display_label text not null,
  sort_order    int  not null default 0
);

-- ---------- sheets ----------
create table if not exists recv_sheets (
  id                uuid primary key default gen_random_uuid(),
  title             text not null,
  po_number         text not null,
  vendor            text,
  status            text not null default 'counting'
                      check (status in ('counting','submitted','closed')),
  notes             text,
  adjustment_number text,          -- NetSuite inventory adjustment #, for the email
  created_by        uuid references recv_people(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  submitted_at      timestamptz,
  closed_at         timestamptz
);
create index if not exists recv_sheets_po_idx      on recv_sheets (po_number);
create index if not exists recv_sheets_created_idx on recv_sheets (created_at desc);

-- A style#-color block within a sheet. A sheet may hold one or many:
-- AC6833-Ivory and AC6833-Navy can share a sheet or live on separate sheets.
create table if not exists recv_sheet_groups (
  id          uuid primary key default gen_random_uuid(),
  sheet_id    uuid not null references recv_sheets(id) on delete cascade,
  style       text not null,
  color       text,
  style_color text not null,
  sort_order  int  not null default 0
);
create index if not exists recv_sheet_groups_sheet_idx on recv_sheet_groups (sheet_id, sort_order);

-- One row per size. counted_qty is maintained by trigger from recv_line_boxes.
create table if not exists recv_sheet_lines (
  id            uuid primary key default gen_random_uuid(),
  sheet_id      uuid not null references recv_sheets(id) on delete cascade,
  group_id      uuid not null references recv_sheet_groups(id) on delete cascade,
  sku           text,
  size          text not null,
  po_qty        integer,
  counted_qty   integer not null default 0,
  pick_bin      text,
  overstock_bin text,
  shelved       boolean not null default false,
  sort_order    int not null default 0
);
create index if not exists recv_sheet_lines_group_idx on recv_sheet_lines (group_id, sort_order);
create index if not exists recv_sheet_lines_sheet_idx on recv_sheet_lines (sheet_id);

-- Multiple box counts per size; they sum to the line's counted_qty.
create table if not exists recv_line_boxes (
  id         uuid primary key default gen_random_uuid(),
  line_id    uuid not null references recv_sheet_lines(id) on delete cascade,
  box_no     int  not null,
  qty        integer not null default 0,
  created_by uuid references recv_people(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (line_id, box_no)
);
create index if not exists recv_line_boxes_line_idx on recv_line_boxes (line_id, box_no);

create or replace function public.recv_recount_line() returns trigger
  language plpgsql security definer set search_path = public as $$
declare tgt uuid := coalesce(new.line_id, old.line_id);
begin
  update recv_sheet_lines l
     set counted_qty = coalesce((select sum(b.qty) from recv_line_boxes b where b.line_id = tgt), 0)
   where l.id = tgt;
  update recv_sheets s set updated_at = now()
   where s.id = (select sheet_id from recv_sheet_lines where id = tgt);
  return null;
end $$;

drop trigger if exists recv_line_boxes_recount on recv_line_boxes;
create trigger recv_line_boxes_recount
  after insert or update or delete on recv_line_boxes
  for each row execute function public.recv_recount_line();

-- ---------- comments ----------
create table if not exists recv_comments (
  id         uuid primary key default gen_random_uuid(),
  sheet_id   uuid not null references recv_sheets(id) on delete cascade,
  line_id    uuid references recv_sheet_lines(id) on delete cascade,
  body       text not null,
  author_id  uuid references recv_people(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists recv_comments_sheet_idx on recv_comments (sheet_id, created_at);

-- ---------- change log (nothing locks; every edit is recorded) ----------
create table if not exists recv_audit (
  id         bigserial primary key,
  sheet_id   uuid references recv_sheets(id) on delete cascade,
  line_id    uuid,
  entity     text not null,
  field      text,
  old_value  text,
  new_value  text,
  actor_id   uuid references recv_people(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists recv_audit_sheet_idx on recv_audit (sheet_id, created_at desc);

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
  if new.pick_bin is distinct from old.pick_bin then
    insert into recv_audit (sheet_id,line_id,entity,field,old_value,new_value,actor_id)
      values (new.sheet_id,new.id,'line','pick_bin',old.pick_bin,new.pick_bin,actor);
  end if;
  if new.overstock_bin is distinct from old.overstock_bin then
    insert into recv_audit (sheet_id,line_id,entity,field,old_value,new_value,actor_id)
      values (new.sheet_id,new.id,'line','overstock_bin',old.overstock_bin,new.overstock_bin,actor);
  end if;
  if new.shelved is distinct from old.shelved then
    insert into recv_audit (sheet_id,line_id,entity,field,old_value,new_value,actor_id)
      values (new.sheet_id,new.id,'line','shelved',old.shelved::text,new.shelved::text,actor);
  end if;
  return new;
end $$;

drop trigger if exists recv_lines_audit on recv_sheet_lines;
create trigger recv_lines_audit after update on recv_sheet_lines
  for each row execute function public.recv_log_line_change();

-- ---------- push notification subscriptions ----------
create table if not exists recv_push_subscriptions (
  id           uuid primary key default gen_random_uuid(),
  person_id    uuid not null references recv_people(id) on delete cascade,
  endpoint     text unique not null,
  subscription jsonb not null,
  created_at   timestamptz not null default now()
);
create index if not exists recv_push_person_idx on recv_push_subscriptions (person_id);

-- ---------- settings (email recipients etc., admin-editable) ----------
create table if not exists recv_settings (
  key        text primary key,
  value      text,
  updated_at timestamptz not null default now()
);

-- ---------- the instructional document (admin-editable) ----------
create table if not exists recv_doc (
  slug       text primary key,
  title      text not null,
  body       jsonb not null default '[]'::jsonb,
  version    int  not null default 1,
  updated_by uuid references recv_people(id) on delete set null,
  updated_at timestamptz not null default now()
);

-- ============================================================
-- Row-level security
-- ============================================================
alter table recv_invited_emails enable row level security;
alter table recv_people         enable row level security;
alter table recv_catalog        enable row level security;
alter table recv_size_labels    enable row level security;
alter table recv_sheets         enable row level security;
alter table recv_sheet_groups   enable row level security;
alter table recv_sheet_lines    enable row level security;
alter table recv_line_boxes     enable row level security;
alter table recv_comments       enable row level security;
alter table recv_audit          enable row level security;
alter table recv_doc            enable row level security;
alter table recv_settings       enable row level security;
alter table recv_push_subscriptions enable row level security;

-- invites: you can see your own; admins manage
drop policy if exists recv_inv_read   on recv_invited_emails;
create policy recv_inv_read on recv_invited_emails for select to authenticated
  using (public.recv_is_admin() or lower(email) = lower(coalesce((select email from auth.users where id = auth.uid()),'')));
drop policy if exists recv_inv_write  on recv_invited_emails;
create policy recv_inv_write on recv_invited_emails for all to authenticated
  using (public.recv_is_admin()) with check (public.recv_is_admin());

-- people: members read the roster; you edit yourself, admins edit anyone
drop policy if exists recv_people_read on recv_people;
create policy recv_people_read on recv_people for select to authenticated
  using (public.recv_is_member());
drop policy if exists recv_people_upd  on recv_people;
create policy recv_people_upd on recv_people for update to authenticated
  using (auth_user_id = auth.uid() or public.recv_is_admin())
  with check (auth_user_id = auth.uid() or public.recv_is_admin());
drop policy if exists recv_people_admin on recv_people;
create policy recv_people_admin on recv_people for all to authenticated
  using (public.recv_is_admin()) with check (public.recv_is_admin());

-- catalog + size labels: members read, admins write (sync runs as service role)
drop policy if exists recv_cat_read on recv_catalog;
create policy recv_cat_read on recv_catalog for select to authenticated using (public.recv_is_member());
drop policy if exists recv_cat_write on recv_catalog;
create policy recv_cat_write on recv_catalog for all to authenticated
  using (public.recv_is_admin()) with check (public.recv_is_admin());

drop policy if exists recv_size_read on recv_size_labels;
create policy recv_size_read on recv_size_labels for select to authenticated using (public.recv_is_member());
drop policy if exists recv_size_write on recv_size_labels;
create policy recv_size_write on recv_size_labels for all to authenticated
  using (public.recv_is_admin()) with check (public.recv_is_admin());

-- sheets and their contents: any member may read and edit (nothing locks),
-- deletes are admin-only so history can't be quietly dropped.
drop policy if exists recv_sheets_rw on recv_sheets;
create policy recv_sheets_rw on recv_sheets for select to authenticated using (public.recv_is_member());
drop policy if exists recv_sheets_ins on recv_sheets;
create policy recv_sheets_ins on recv_sheets for insert to authenticated with check (public.recv_is_member());
drop policy if exists recv_sheets_upd on recv_sheets;
create policy recv_sheets_upd on recv_sheets for update to authenticated
  using (public.recv_is_member()) with check (public.recv_is_member());
drop policy if exists recv_sheets_del on recv_sheets;
create policy recv_sheets_del on recv_sheets for delete to authenticated using (public.recv_is_admin());

drop policy if exists recv_groups_rw on recv_sheet_groups;
create policy recv_groups_rw on recv_sheet_groups for all to authenticated
  using (public.recv_is_member()) with check (public.recv_is_member());

drop policy if exists recv_lines_rw on recv_sheet_lines;
create policy recv_lines_rw on recv_sheet_lines for all to authenticated
  using (public.recv_is_member()) with check (public.recv_is_member());

drop policy if exists recv_boxes_rw on recv_line_boxes;
create policy recv_boxes_rw on recv_line_boxes for all to authenticated
  using (public.recv_is_member()) with check (public.recv_is_member());

-- comments: members read and post; author or admin may edit/remove
drop policy if exists recv_com_read on recv_comments;
create policy recv_com_read on recv_comments for select to authenticated using (public.recv_is_member());
drop policy if exists recv_com_ins on recv_comments;
create policy recv_com_ins on recv_comments for insert to authenticated
  with check (public.recv_is_member() and author_id = public.recv_me());
drop policy if exists recv_com_mod on recv_comments;
create policy recv_com_mod on recv_comments for update to authenticated
  using (author_id = public.recv_me() or public.recv_is_admin())
  with check (author_id = public.recv_me() or public.recv_is_admin());
drop policy if exists recv_com_del on recv_comments;
create policy recv_com_del on recv_comments for delete to authenticated
  using (author_id = public.recv_me() or public.recv_is_admin());

-- audit: members read, nobody edits (trigger writes it as security definer)
drop policy if exists recv_audit_read on recv_audit;
create policy recv_audit_read on recv_audit for select to authenticated using (public.recv_is_member());

-- doc: members read, admins edit
drop policy if exists recv_doc_read on recv_doc;
create policy recv_doc_read on recv_doc for select to authenticated using (public.recv_is_member());
drop policy if exists recv_doc_write on recv_doc;
create policy recv_doc_write on recv_doc for all to authenticated
  using (public.recv_is_admin()) with check (public.recv_is_admin());

drop policy if exists recv_set_read on recv_settings;
create policy recv_set_read on recv_settings for select to authenticated using (public.recv_is_member());
drop policy if exists recv_set_write on recv_settings;
create policy recv_set_write on recv_settings for all to authenticated
  using (public.recv_is_admin()) with check (public.recv_is_admin());

-- push subscriptions: you manage your own devices; admins can clean up
drop policy if exists recv_push_own on recv_push_subscriptions;
create policy recv_push_own on recv_push_subscriptions for all to authenticated
  using (person_id = public.recv_me() or public.recv_is_admin())
  with check (person_id = public.recv_me() or public.recv_is_admin());

-- ---------- seed ----------
insert into recv_invited_emails (email, name, is_admin)
  values ('karley@justforkix.com', 'Karley', true)
  on conflict (email) do update set is_admin = true, name = 'Karley';

-- email_to is intentionally blank: set it in Admin -> Email so nothing is
-- ever addressed to a guessed address.
insert into recv_settings (key, value) values
  ('email_to',       ''),
  ('email_cc',       'karley@justforkix.com'),
  ('email_greeting', 'Hi Tristan,')
  on conflict (key) do nothing;
