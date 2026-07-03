-- Roody credits backend — run this once in Supabase SQL Editor.
-- Model: an invite CODE is the identity. You mint codes, users paste them
-- into Roody settings. Every brain call burns 1 credit; daily_limit resets
-- by calendar day (UTC).

create table if not exists codes (
  code        text primary key,
  name        text,                       -- who you gave it to (your note)
  daily_limit int  not null default 50,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

create table if not exists usage (
  code  text not null references codes(code),
  day   date not null default current_date,
  count int  not null default 0,
  primary key (code, day)
);

-- Atomic "spend one credit": validates code, increments today's counter,
-- rejects when over the limit. One round-trip, no race conditions.
create or replace function use_credit(p_code text)
returns json
language plpgsql
security definer
as $$
declare
  v_limit int;
  v_count int;
begin
  select daily_limit into v_limit from codes where code = p_code and active;
  if v_limit is null then
    return json_build_object('ok', false, 'reason', 'invalid');
  end if;

  insert into usage (code, day, count) values (p_code, current_date, 1)
  on conflict (code, day) do update set count = usage.count + 1
  returning count into v_count;

  if v_count > v_limit then
    return json_build_object('ok', false, 'reason', 'limit', 'used', v_count, 'limit', v_limit);
  end if;

  return json_build_object('ok', true, 'used', v_count, 'limit', v_limit);
end;
$$;

-- Validate a code without spending (used for TTS/STT calls that ride along
-- with an already-paid message).
create or replace function check_code(p_code text)
returns boolean
language sql
security definer
as $$
  select exists(select 1 from codes where code = p_code and active);
$$;

-- Lock the tables down: only the service role (the Edge Function) touches them.
alter table codes enable row level security;
alter table usage enable row level security;

-- ---------------------------------------------------------------------------
-- YOUR ADMIN CHEAT SHEET (run these in the SQL Editor whenever needed)
-- ---------------------------------------------------------------------------
-- Mint a code for a tester:
--   insert into codes (code, name) values ('ROODY-' || upper(substr(md5(random()::text), 1, 8)), 'First tester');
--   select code from codes order by created_at desc limit 1;
--
-- See today's usage:
--   select c.name, u.code, u.count, c.daily_limit
--   from usage u join codes c using (code)
--   where day = current_date order by u.count desc;
--
-- Kill a user instantly:
--   update codes set active = false where code = 'ROODY-XXXXXXXX';
--
-- Raise one user's limit:
--   update codes set daily_limit = 200 where code = 'ROODY-XXXXXXXX';
