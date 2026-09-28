-- Beat Earth — worldwide rock-paper-scissors elimination tournament
-- Initial schema: tables, row-level security, game logic (RPC) and the season "tick".

-- ─────────────────────────────────────────────────────────────
-- Types
-- ─────────────────────────────────────────────────────────────
create type public.season_status as enum ('registration', 'running', 'finished');
create type public.rps as enum ('rock', 'paper', 'scissors');

-- ─────────────────────────────────────────────────────────────
-- Tables
-- ─────────────────────────────────────────────────────────────

-- Public player profile (one per Google account)
create table public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  nickname    text not null check (char_length(nickname) between 2 and 16),
  country     text not null check (country ~ '^[A-Z]{2}$'),
  lang        text not null default 'en' check (lang in ('ru', 'en', 'zh')),
  created_at  timestamptz not null default now()
);

create table public.seasons (
  id                  bigint generated always as identity primary key,
  name                text not null,
  status              public.season_status not null default 'registration',
  starts_at           timestamptz not null,
  round_minutes       int not null default 120 check (round_minutes > 0),
  final_size          int not null default 16 check (final_size >= 2),
  final_at            timestamptz,               -- first round with <= final_size players waits for this time (live final)
  final_move_seconds  int not null default 120,  -- per-game time in the live final
  current_round       int not null default 0,
  champion            uuid references public.profiles (id),
  finished_at         timestamptz,
  created_at          timestamptz not null default now()
);

-- A player's participation in a season
create table public.entries (
  season_id         bigint not null references public.seasons (id) on delete cascade,
  user_id           uuid not null references public.profiles (id) on delete cascade,
  alive             boolean not null default true,
  eliminated_round  int,
  joined_at         timestamptz not null default now(),
  primary key (season_id, user_id)
);
create index entries_alive_idx on public.entries (season_id) where alive;

-- Night-mode presets: private, consumed one per round when the player doesn't move in time
create table public.presets (
  season_id   bigint not null references public.seasons (id) on delete cascade,
  user_id     uuid not null references public.profiles (id) on delete cascade,
  moves       public.rps[] not null default '{}',
  updated_at  timestamptz not null default now(),
  primary key (season_id, user_id),
  check (cardinality(moves) <= 5)
);

create table public.matches (
  id           bigint generated always as identity primary key,
  season_id    bigint not null references public.seasons (id) on delete cascade,
  round        int not null,
  p1           uuid not null references public.profiles (id),
  p2           uuid references public.profiles (id),   -- null = bye (p1 advances)
  best_of      int not null default 1 check (best_of in (1, 3, 5)),
  p1_wins      int not null default 0,
  p2_wins      int not null default 0,
  game_no      int not null default 1,                  -- current game; draws also advance it
  starts_at    timestamptz not null,
  deadline     timestamptz not null,
  winner       uuid references public.profiles (id),
  finished_at  timestamptz
);
create index matches_round_idx on public.matches (season_id, round);
create index matches_p1_idx on public.matches (p1);
create index matches_p2_idx on public.matches (p2);
create index matches_open_idx on public.matches (season_id, round) where winner is null;
create index matches_due_idx on public.matches (deadline) where winner is null;

-- Sealed moves. Only the owner can read them until the game is revealed in public.games.
create table public.moves (
  match_id    bigint not null references public.matches (id) on delete cascade,
  game_no     int not null,
  user_id     uuid not null references public.profiles (id),
  move        public.rps not null,
  auto        boolean not null default false,
  created_at  timestamptz not null default now(),
  primary key (match_id, game_no, user_id)
);

-- Revealed games (public)
create table public.games (
  match_id    bigint not null references public.matches (id) on delete cascade,
  game_no     int not null,
  p1_move     public.rps not null,
  p2_move     public.rps not null,
  p1_auto     boolean not null default false,
  p2_auto     boolean not null default false,
  result      smallint not null check (result in (0, 1, 2)),  -- 0 draw, 1 p1 won, 2 p2 won
  created_at  timestamptz not null default now(),
  primary key (match_id, game_no)
);

-- ─────────────────────────────────────────────────────────────
-- Row-level security: everything is read-only for clients,
-- all writes go through the SECURITY DEFINER functions below.
-- ─────────────────────────────────────────────────────────────
alter table public.profiles enable row level security;
alter table public.seasons  enable row level security;
alter table public.entries  enable row level security;
alter table public.presets  enable row level security;
alter table public.matches  enable row level security;
alter table public.moves    enable row level security;
alter table public.games    enable row level security;

create policy "profiles are public" on public.profiles for select using (true);
create policy "seasons are public"  on public.seasons  for select using (true);
create policy "entries are public"  on public.entries  for select using (true);
create policy "matches are public"  on public.matches  for select using (true);
create policy "games are public"    on public.games    for select using (true);
create policy "own presets"         on public.presets  for select using (user_id = auth.uid());
create policy "own moves"           on public.moves    for select using (user_id = auth.uid());

revoke insert, update, delete, truncate on all tables in schema public from anon, authenticated;

-- ─────────────────────────────────────────────────────────────
-- Game logic
-- ─────────────────────────────────────────────────────────────

create or replace function public.rps_beats(a public.rps, b public.rps)
returns boolean language sql immutable as $$
  select (a = 'rock' and b = 'scissors') or (a = 'scissors' and b = 'paper') or (a = 'paper' and b = 'rock');
$$;

create or replace function public.random_move()
returns public.rps language sql volatile as $$
  select (array['rock','paper','scissors']::public.rps[])[1 + floor(random() * 3)::int];
$$;

-- Reveal the current game of a match if both sealed moves are in. Returns true if a game was revealed.
-- Caller must hold a row lock on the match.
create or replace function public._try_reveal(p_match bigint)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  m        matches%rowtype;
  mv1      moves%rowtype;
  mv2      moves%rowtype;
  res      smallint;
  need     int;
  s        seasons%rowtype;
begin
  select * into m from matches where id = p_match;
  if m.winner is not null or m.p2 is null then return false; end if;

  select * into mv1 from moves where match_id = m.id and game_no = m.game_no and user_id = m.p1;
  select * into mv2 from moves where match_id = m.id and game_no = m.game_no and user_id = m.p2;
  if mv1.move is null or mv2.move is null then return false; end if;

  res := case when mv1.move = mv2.move then 0
              when rps_beats(mv1.move, mv2.move) then 1
              else 2 end;

  insert into games (match_id, game_no, p1_move, p2_move, p1_auto, p2_auto, result)
  values (m.id, m.game_no, mv1.move, mv2.move, mv1.auto, mv2.auto, res);

  m.p1_wins := m.p1_wins + (res = 1)::int;
  m.p2_wins := m.p2_wins + (res = 2)::int;
  need := m.best_of / 2 + 1;

  if m.p1_wins >= need or m.p2_wins >= need then
    m.winner := case when m.p1_wins >= need then m.p1 else m.p2 end;
    update matches
       set p1_wins = m.p1_wins, p2_wins = m.p2_wins, winner = m.winner,
           game_no = m.game_no + 1, finished_at = now()
     where id = m.id;
    update entries set alive = false, eliminated_round = m.round
     where season_id = m.season_id
       and user_id = case when m.winner = m.p1 then m.p2 else m.p1 end;
  else
    -- next game (replay after a draw, or next game of a best-of-3)
    select * into s from seasons where id = m.season_id;
    update matches
       set p1_wins = m.p1_wins, p2_wins = m.p2_wins, game_no = m.game_no + 1,
           deadline = case
             when m.best_of > 1 then greatest(m.deadline, now() + make_interval(secs => s.final_move_seconds))
             else greatest(m.deadline, now() + interval '5 minutes')   -- a late draw still leaves time to replay
           end
     where id = m.id;
  end if;
  return true;
end $$;

-- Deadline passed: play for whoever didn't move (night preset for the first game of a round, otherwise random)
-- until the match is decided. Caller must hold a row lock on the match.
create or replace function public._auto_finish(p_match bigint)
returns void language plpgsql security definer set search_path = public as $$
declare
  m      matches%rowtype;
  pid    uuid;
  mv     rps;
  guard  int := 0;
begin
  loop
    select * into m from matches where id = p_match;
    exit when m.winner is not null;
    guard := guard + 1;
    if guard > 100 then raise exception 'auto_finish runaway on match %', p_match; end if;

    foreach pid in array array[m.p1, m.p2] loop
      if not exists (select 1 from moves where match_id = m.id and game_no = m.game_no and user_id = pid) then
        mv := null;
        if m.game_no = 1 then
          -- pop the first night preset, if any
          select moves[1] into mv from presets
           where season_id = m.season_id and user_id = pid for update;
          if mv is not null then
            update presets set moves = moves[2:], updated_at = now()
             where season_id = m.season_id and user_id = pid;
          end if;
        end if;
        insert into moves (match_id, game_no, user_id, move, auto)
        values (m.id, m.game_no, pid, coalesce(mv, random_move()), true);
      end if;
    end loop;

    perform _try_reveal(m.id);
  end loop;
end $$;

-- Pair all alive players of a season into the next round.
create or replace function public._create_round(p_season bigint)
returns void language plpgsql security definer set search_path = public as $$
declare
  s        seasons%rowtype;
  players  uuid[];
  n        int;
  r        int;
  is_final boolean;
  t0       timestamptz;
  t1       timestamptz;
  i        int := 1;
begin
  select * into s from seasons where id = p_season;
  select array_agg(user_id order by random()) into players from entries where season_id = p_season and alive;
  n := coalesce(cardinality(players), 0);
  r := s.current_round + 1;
  is_final := n <= s.final_size;

  t0 := now();
  if is_final and s.final_at is not null and s.final_at > now() then t0 := s.final_at; end if;
  t1 := t0 + case when is_final then make_interval(secs => s.final_move_seconds)
                  else make_interval(mins => s.round_minutes) end;

  while i + 1 <= n loop
    insert into matches (season_id, round, p1, p2, best_of, starts_at, deadline)
    values (p_season, r, players[i], players[i + 1], case when is_final then 3 else 1 end, t0, t1);
    i := i + 2;
  end loop;
  if i = n then  -- odd player out gets a bye
    insert into matches (season_id, round, p1, p2, starts_at, deadline, winner, finished_at)
    values (p_season, r, players[i], null, t0, t0, players[i], now());
  end if;

  update seasons set current_round = r where id = p_season;
end $$;

-- Advance one season: start it, auto-finish overdue matches, open the next round, crown the champion.
create or replace function public.process_season(p_season bigint)
returns void language plpgsql security definer set search_path = public as $$
declare
  s      seasons%rowtype;
  mid    bigint;
  n_alive  int;
begin
  select * into s from seasons where id = p_season for update skip locked;
  if not found or s.status = 'finished' then return; end if;

  if s.status = 'registration' then
    if now() < s.starts_at then return; end if;
    select count(*) into n_alive from entries where season_id = p_season and alive;
    if n_alive < 2 then return; end if;   -- wait for at least two players
    update seasons set status = 'running' where id = p_season;
    perform _create_round(p_season);
    return;
  end if;

  -- overdue matches of the current round
  for mid in
    select id from matches
     where season_id = p_season and round = s.current_round and winner is null and deadline <= now()
  loop
    perform 1 from matches where id = mid for update;
    perform _auto_finish(mid);
  end loop;

  if exists (select 1 from matches where season_id = p_season and round = s.current_round and winner is null) then
    return;
  end if;

  select count(*) into n_alive from entries where season_id = p_season and alive;
  if n_alive <= 1 then
    update seasons
       set status = 'finished', finished_at = now(),
           champion = (select user_id from entries where season_id = p_season and alive limit 1)
     where id = p_season;
  else
    perform _create_round(p_season);
  end if;
end $$;

-- Called by pg_cron every minute.
create or replace function public.tick()
returns void language plpgsql security definer set search_path = public as $$
declare sid bigint;
begin
  for sid in select id from seasons where status <> 'finished' order by id loop
    perform process_season(sid);
  end loop;
end $$;

-- ─────────────────────────────────────────────────────────────
-- Client RPC
-- ─────────────────────────────────────────────────────────────

-- Sign up for a season (creates/updates the profile).
create or replace function public.join_season(p_season bigint, p_nickname text, p_country text, p_lang text default 'en')
returns void language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'not_authenticated'; end if;
  if not exists (select 1 from seasons where id = p_season and status = 'registration') then
    raise exception 'registration_closed';
  end if;
  insert into profiles (id, nickname, country, lang)
  values (uid, trim(p_nickname), upper(p_country), p_lang)
  on conflict (id) do update set nickname = excluded.nickname, country = excluded.country, lang = excluded.lang;
  insert into entries (season_id, user_id) values (p_season, uid) on conflict do nothing;
end $$;

-- Seal a move for the current game of my current match.
create or replace function public.submit_move(p_match bigint, p_move public.rps)
returns void language plpgsql security definer set search_path = public as $$
declare
  uid  uuid := auth.uid();
  m    matches%rowtype;
begin
  if uid is null then raise exception 'not_authenticated'; end if;
  select * into m from matches where id = p_match for update;
  if not found or uid not in (m.p1, coalesce(m.p2, m.p1)) then raise exception 'not_your_match'; end if;
  if m.winner is not null then raise exception 'match_finished'; end if;
  if now() < m.starts_at then raise exception 'not_started'; end if;
  if now() > m.deadline then raise exception 'too_late'; end if;

  insert into moves (match_id, game_no, user_id, move) values (m.id, m.game_no, uid, p_move)
  on conflict do nothing;
  if not found then raise exception 'already_moved'; end if;

  perform _try_reveal(m.id);

  -- last match of the round finished → open the next round right away
  if not exists (select 1 from matches where season_id = m.season_id and round = m.round and winner is null) then
    perform process_season(m.season_id);
  end if;
end $$;

-- Night mode: up to 5 moves used, one per round, whenever I don't move in time.
create or replace function public.set_presets(p_season bigint, p_moves public.rps[])
returns void language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'not_authenticated'; end if;
  if not exists (select 1 from entries where season_id = p_season and user_id = uid and alive) then
    raise exception 'not_in_game';
  end if;
  insert into presets (season_id, user_id, moves) values (p_season, uid, coalesce(p_moves, '{}'))
  on conflict (season_id, user_id) do update set moves = excluded.moves, updated_at = now();
end $$;

-- Public season overview for the landing page and side panels.
create or replace function public.season_stats(p_season bigint)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'season', to_jsonb(s) - 'champion',
    'registered', (select count(*) from entries where season_id = s.id),
    'alive', (select count(*) from entries where season_id = s.id and alive),
    'countries', coalesce((
      select jsonb_agg(c order by (c->>'alive')::int desc)
        from (select jsonb_build_object('country', p.country,
                                        'total', count(*),
                                        'alive', count(*) filter (where e.alive)) c
                from entries e join profiles p on p.id = e.user_id
               where e.season_id = s.id
               group by p.country
               order by count(*) filter (where e.alive) desc
               limit 20) t), '[]'::jsonb),
    'champion', (select jsonb_build_object('nickname', nickname, 'country', country) from profiles where id = s.champion)
  )
  from seasons s where s.id = p_season;
$$;

-- Everything the signed-in player needs to render their screen.
create or replace function public.my_state(p_season bigint)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  uid  uuid := auth.uid();
  m    matches%rowtype;
  opp  uuid;
begin
  if uid is null then return null; end if;
  select * into m from matches
   where season_id = p_season and (p1 = uid or p2 = uid)
   order by round desc limit 1;
  opp := case when m.p1 = uid then m.p2 else m.p1 end;

  return jsonb_build_object(
    'profile', (select to_jsonb(p) from profiles p where id = uid),
    'entry',   (select to_jsonb(e) from entries e where season_id = p_season and user_id = uid),
    'presets', (select moves from presets where season_id = p_season and user_id = uid),
    'wins',    (select count(*) from matches where season_id = p_season and winner = uid and p2 is not null),
    'beaten',  coalesce((select jsonb_agg(jsonb_build_object('nickname', pr.nickname, 'country', pr.country, 'round', x.round) order by x.round desc)
                  from matches x join profiles pr on pr.id = case when x.p1 = uid then x.p2 else x.p1 end
                 where x.season_id = p_season and x.winner = uid and x.p2 is not null), '[]'::jsonb),
    'match', case when m.id is null then null else jsonb_build_object(
      'id', m.id, 'round', m.round, 'best_of', m.best_of, 'game_no', m.game_no,
      'starts_at', m.starts_at, 'deadline', m.deadline, 'finished', m.winner is not null,
      'bye', m.p2 is null,
      'won', m.winner = uid,
      'my_wins', case when m.p1 = uid then m.p1_wins else m.p2_wins end,
      'opp_wins', case when m.p1 = uid then m.p2_wins else m.p1_wins end,
      'opponent', (select jsonb_build_object('nickname', nickname, 'country', country) from profiles where id = opp),
      'my_move', (select move from moves where match_id = m.id and game_no = m.game_no and user_id = uid),
      'games', coalesce((select jsonb_agg(jsonb_build_object(
                  'game_no', g.game_no,
                  'mine',   case when m.p1 = uid then g.p1_move else g.p2_move end,
                  'theirs', case when m.p1 = uid then g.p2_move else g.p1_move end,
                  'my_auto', case when m.p1 = uid then g.p1_auto else g.p2_auto end,
                  'result', case g.result when 0 then 'draw'
                                           when (case when m.p1 = uid then 1 else 2 end) then 'win'
                                           else 'lose' end) order by g.game_no)
                 from games g where g.match_id = m.id), '[]'::jsonb)
    ) end
  );
end $$;

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.join_season(bigint, text, text, text) to authenticated;
grant execute on function public.submit_move(bigint, public.rps)        to authenticated;
grant execute on function public.set_presets(bigint, public.rps[])      to authenticated;
grant execute on function public.my_state(bigint)                       to authenticated;
grant execute on function public.season_stats(bigint)                   to anon, authenticated;

-- Realtime: clients listen for their match and its revealed games
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.matches, public.games, public.seasons;
  end if;
end $$;
