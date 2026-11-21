-- Rent a Vacuum: everything lives in its own "rentavacuum" schema, which anon can't touch directly.
-- The website only talks to the vac_* functions below. Admin password is set separately (not in git):
--   insert into rentavacuum.admin values ('you@example.com', extensions.crypt('PASSWORD', extensions.gen_salt('bf', 10)));
create schema if not exists rentavacuum;
revoke all on schema rentavacuum from public, anon, authenticated;

create table rentavacuum.settings (
  id int primary key default 1 check (id = 1),
  start_date date not null,
  end_date date not null,
  first_hour int not null,
  last_hour int not null,
  slot_hours int not null,
  price_per_slot numeric not null,
  tz text not null default 'Europe/Amsterdam'
);
-- one rental per day: pick up 18:00, return 18:00 next day (first_hour=18, slot_hours=24, last_hour=18+24)
insert into rentavacuum.settings values (1, '2026-11-23', '2026-12-16', 18, 42, 24, 20, 'Europe/Amsterdam');

create table rentavacuum.bookings (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null,
  slot_start timestamptz not null,
  name text not null check (length(name) between 1 and 80),
  apartment text not null check (length(apartment) between 1 and 20),
  phone text not null check (length(phone) between 1 and 30),
  note text check (length(note) <= 300),
  status text not null default 'pending' check (status in ('pending','confirmed','cancelled','blocked')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index bookings_active_slot on rentavacuum.bookings(slot_start) where status <> 'cancelled';
create index bookings_group on rentavacuum.bookings(group_id);

create table rentavacuum.admin (email text primary key, pw_hash text not null);
create table rentavacuum.admin_sessions (token_hash text primary key, expires_at timestamptz not null);
create table rentavacuum.login_attempts (id bigserial primary key, at timestamptz not null default now(), success boolean not null);

alter table rentavacuum.settings enable row level security;
alter table rentavacuum.bookings enable row level security;
alter table rentavacuum.admin enable row level security;
alter table rentavacuum.admin_sessions enable row level security;
alter table rentavacuum.login_attempts enable row level security;
revoke all on all tables in schema rentavacuum from public, anon, authenticated;

-- ---------- public ----------
create or replace function public.vac_config()
returns json language sql stable security definer set search_path = '' as $$
  select json_build_object('start_date', start_date, 'end_date', end_date, 'first_hour', first_hour,
    'last_hour', last_hour, 'slot_hours', slot_hours, 'price_per_slot', price_per_slot, 'tz', tz)
  from rentavacuum.settings where id = 1;
$$;

-- only times + status, never names/phones
create or replace function public.vac_slots()
returns json language sql stable security definer set search_path = '' as $$
  select coalesce(json_agg(json_build_object('slot_start', b.slot_start,
    'status', case when b.status = 'blocked' then 'confirmed' else b.status end)), '[]'::json)
  from rentavacuum.bookings b where b.status <> 'cancelled';
$$;

-- renter checks their own booking by its (unguessable) group id
create or replace function public.vac_booking_status(p_group uuid)
returns json language sql stable security definer set search_path = '' as $$
  select coalesce(json_agg(json_build_object('slot_start', b.slot_start, 'status', b.status)), '[]'::json)
  from rentavacuum.bookings b where b.group_id = p_group;
$$;

create or replace function public.vac_book(p_slots timestamptz[], p_name text, p_apartment text, p_phone text, p_note text default null)
returns json language plpgsql volatile security definer set search_path = '' as $$
declare
  s rentavacuum.settings;
  t timestamptz;
  loc timestamp;
  gid uuid := gen_random_uuid();
  recent int;
  h int;
  days text;
begin
  select * into s from rentavacuum.settings where id = 1;
  if p_slots is null or array_length(p_slots, 1) is null then raise exception 'Pick at least one day'; end if;
  if array_length(p_slots, 1) > 4 then raise exception 'Max 4 days per booking'; end if;
  if length(trim(coalesce(p_name,''))) = 0 or length(trim(coalesce(p_apartment,''))) = 0 or length(trim(coalesce(p_phone,''))) < 4 then
    raise exception 'Name, apartment and phone are required';
  end if;
  select count(*) into recent from rentavacuum.bookings where created_at > now() - interval '10 minutes' and status <> 'blocked';
  if recent > 30 then raise exception 'Too many bookings right now, try again in a few minutes'; end if;

  foreach t in array p_slots loop
    loc := t at time zone s.tz;
    h := extract(hour from loc)::int;
    if t <= now() then raise exception 'That day has already started'; end if;
    if loc::date < s.start_date or loc::date > s.end_date then raise exception 'Slot outside rental period'; end if;
    if extract(minute from loc) <> 0 or extract(second from loc) <> 0
       or h < s.first_hour or h + s.slot_hours > s.last_hour
       or (h - s.first_hour) % s.slot_hours <> 0 then
      raise exception 'Invalid slot';
    end if;
    begin
      insert into rentavacuum.bookings(group_id, slot_start, name, apartment, phone, note)
      values (gid, t, trim(p_name), trim(p_apartment), trim(p_phone), nullif(trim(coalesce(p_note,'')), ''));
    exception when unique_violation then
      raise exception 'Sorry, one of those days was just taken. Refresh and pick another.';
    end;
  end loop;

  select string_agg(to_char(x at time zone s.tz, 'Dy DD Mon'), ', ' order by x) into days from unnest(p_slots) x;
  perform rentavacuum.notify(
    'New booking · €' || (array_length(p_slots,1) * s.price_per_slot)::text,
    trim(p_name) || ' (apt ' || trim(p_apartment) || ') reserved ' || days || '. Confirm once paid.',
    'broom');

  return json_build_object('group_id', gid, 'slots', array_length(p_slots,1), 'total', array_length(p_slots,1) * s.price_per_slot);
end $$;

-- ---------- admin ----------
create or replace function rentavacuum.check_session(p_token text)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if p_token is null or not exists (select 1 from rentavacuum.admin_sessions
     where token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex') and expires_at > now()) then
    raise exception 'Not authorized' using errcode = '28000';
  end if;
end $$;

-- bcrypt check, 5 failed tries => 15 min lockout, returns a random session token (only its hash is stored)
create or replace function public.vac_admin_login(p_email text, p_password text)
returns text language plpgsql volatile security definer set search_path = '' as $$
declare
  fails int;
  ok boolean;
  tok text;
begin
  select count(*) into fails from rentavacuum.login_attempts where not success and at > now() - interval '15 minutes';
  if fails >= 5 then raise exception 'Too many failed attempts. Locked for 15 minutes.'; end if;
  select exists(select 1 from rentavacuum.admin a where a.email = lower(trim(p_email))
    and a.pw_hash = extensions.crypt(p_password, a.pw_hash)) into ok;
  insert into rentavacuum.login_attempts(success) values (ok);
  if not ok then return null; end if;
  tok := encode(extensions.gen_random_bytes(32), 'hex');
  delete from rentavacuum.admin_sessions where expires_at < now();
  insert into rentavacuum.admin_sessions values (encode(extensions.digest(tok, 'sha256'), 'hex'), now() + interval '7 days');
  return tok;
end $$;

create or replace function public.vac_admin_logout(p_token text)
returns void language sql volatile security definer set search_path = '' as $$
  delete from rentavacuum.admin_sessions where token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex');
$$;

create or replace function public.vac_admin_bookings(p_token text)
returns json language plpgsql stable security definer set search_path = '' as $$
declare r json;
begin
  perform rentavacuum.check_session(p_token);
  select coalesce(json_agg(b order by b.slot_start), '[]'::json) into r from rentavacuum.bookings b;
  return r;
end $$;

create or replace function public.vac_admin_set_status(p_token text, p_group uuid, p_status text)
returns void language plpgsql volatile security definer set search_path = '' as $$
begin
  perform rentavacuum.check_session(p_token);
  if p_status not in ('pending','confirmed','cancelled') then raise exception 'Bad status'; end if;
  if p_status <> 'cancelled' and exists (
    select 1 from rentavacuum.bookings x join rentavacuum.bookings y on x.slot_start = y.slot_start
    where x.group_id = p_group and y.group_id <> p_group and y.status <> 'cancelled') then
    raise exception 'A day in this booking is already taken by someone else';
  end if;
  update rentavacuum.bookings set status = p_status, updated_at = now() where group_id = p_group and status <> 'blocked';
end $$;

create or replace function public.vac_admin_block(p_token text, p_slot timestamptz, p_block boolean)
returns void language plpgsql volatile security definer set search_path = '' as $$
begin
  perform rentavacuum.check_session(p_token);
  if p_block then
    insert into rentavacuum.bookings(group_id, slot_start, name, apartment, phone, status)
    values (gen_random_uuid(), p_slot, 'Blocked', '-', '-', 'blocked');
  else
    delete from rentavacuum.bookings where slot_start = p_slot and status = 'blocked';
  end if;
end $$;

revoke all on function rentavacuum.check_session(text) from public, anon, authenticated;
revoke all on function public.vac_config(), public.vac_slots(), public.vac_booking_status(uuid),
  public.vac_book(timestamptz[],text,text,text,text),
  public.vac_admin_login(text,text), public.vac_admin_logout(text), public.vac_admin_bookings(text),
  public.vac_admin_set_status(text,uuid,text), public.vac_admin_block(text,timestamptz,boolean) from public;
grant execute on function public.vac_config(), public.vac_slots(), public.vac_booking_status(uuid),
  public.vac_book(timestamptz[],text,text,text,text),
  public.vac_admin_login(text,text), public.vac_admin_logout(text), public.vac_admin_bookings(text),
  public.vac_admin_set_status(text,uuid,text), public.vac_admin_block(text,timestamptz,boolean) to anon, authenticated;

-- ---------- phone alerts (ntfy.sh) ----------
-- The secret topic lives only in the DB:
--   insert into rentavacuum.notify_config(topic) values ('rentavacuum-' || encode(extensions.gen_random_bytes(9), 'hex'));
create table if not exists rentavacuum.notify_config (id int primary key default 1 check (id = 1), topic text not null, email text);
alter table rentavacuum.notify_config enable row level security;
revoke all on rentavacuum.notify_config from public, anon, authenticated;

create or replace function rentavacuum.notify(p_title text, p_message text, p_tags text)
returns void language plpgsql security definer set search_path = '' as $$
declare c rentavacuum.notify_config; b jsonb;
begin
  select * into c from rentavacuum.notify_config where id = 1;
  if c.topic is null then return; end if;
  b := jsonb_build_object('topic', c.topic, 'title', p_title, 'message', p_message, 'tags', jsonb_build_array(p_tags),
                          'click', 'https://rentavacuum.vercel.app/admin', 'priority', 4);
  -- note: ntfy.sh rejects 'email' for anonymous publishers, so leave notify_config.email null
  if c.email is not null then b := b || jsonb_build_object('email', c.email); end if;
  perform net.http_post(url := 'https://ntfy.sh', body := b, headers := '{"Content-Type": "application/json"}'::jsonb);
exception when others then
  null; -- an alert problem must never block a booking
end $$;
revoke all on function rentavacuum.notify(text, text, text) from public, anon, authenticated;
