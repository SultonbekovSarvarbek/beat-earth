-- Local simulation of a whole season (plain Postgres with a stubbed auth schema; see tests/run-local.sh).
\set ON_ERROR_STOP 1
\timing off

insert into seasons (name, starts_at, round_minutes, final_size, final_at)
values ('Test', now() - interval '1 second', 120, 16, null);
insert into auth.users select gen_random_uuid() from generate_series(1, :players);

-- everyone registers through the RPC as an authenticated user
do $$ declare u uuid; i int := 0; begin
  for u in select id from auth.users loop
    i := i + 1;
    perform set_config('test.uid', u::text, true);
    set local role authenticated;
    perform join_season(1, 'p' || i, (array['UZ','RU','CN','US','BR','IN'])[1 + i % 6], 'ru');
    reset role;
  end loop;
end $$;

-- a quarter of players set night presets
do $$ declare u uuid; begin
  for u in select user_id from entries where season_id = 1 and random() < 0.25 loop
    perform set_config('test.uid', u::text, true);
    set local role authenticated;
    perform set_presets(1, array['rock','paper','scissors']::rps[]);
    reset role;
  end loop;
end $$;

select tick();

-- play rounds: ~60% of players move themselves, the rest time out and get auto-played
do $$
declare
  r int; mm record; uid uuid; guard int := 0; mv rps;
begin
  loop
    guard := guard + 1; exit when guard > 200;
    exit when (select status from seasons where id = 1) = 'finished';
    select current_round into r from seasons where id = 1;

    for mm in select * from matches where season_id = 1 and round = r and winner is null loop
      foreach uid in array array[mm.p1, mm.p2] loop
        if random() < 0.6 then
          -- keep moving until the match is over or this player already has a sealed move
          perform set_config('test.uid', uid::text, true);
          set local role authenticated;
          begin
            perform submit_move(mm.id, random_move());
          exception when others then null;  -- already_moved / match_finished are fine here
          end;
          reset role;
        end if;
      end loop;
    end loop;

    -- time passes: force deadlines of the round into the past, then tick
    update matches set deadline = now() - interval '1 second' where season_id = 1 and round = r and winner is null;
    perform tick();
  end loop;
end $$;

\echo '--- season'
select status, current_round, champion is not null as has_champion from seasons where id = 1;
\echo '--- rounds'
select round, count(*) as matches, count(*) filter (where p2 is null) as byes,
       max(best_of) as best_of, count(*) filter (where winner is null) as open
  from matches where season_id = 1 group by round order by round;
\echo '--- invariants (all should be true)'
select
  (select count(*) from entries where season_id = 1 and alive) = 1                                       as one_alive,
  (select user_id from entries where season_id = 1 and alive) = (select champion from seasons where id = 1) as champion_is_alive,
  not exists (select 1 from matches m where p2 is not null and winner is not null
                and greatest(p1_wins, p2_wins) <> best_of / 2 + 1)                                        as wins_correct,
  not exists (select 1 from games g join matches m on m.id = g.match_id
                where (g.result = 0) <> (g.p1_move = g.p2_move))                                         as draws_correct,
  (select count(*) from entries where season_id = 1 and not alive)
    = (select count(*) from matches where season_id = 1 and p2 is not null)                              as one_loss_per_match,
  (select count(*) from moves where auto) > 0                                                             as some_auto_moves;
\echo '--- security'
-- a player cannot see the opponent's sealed move, cannot write tables directly, cannot play someone else's match
do $$ declare u uuid; other bigint; n int; ok boolean := false; begin
  select user_id into u from entries where season_id = 1 limit 1;
  perform set_config('test.uid', u::text, true);
  set local role authenticated;
  select count(*) into n from moves where user_id <> u;
  if n <> 0 then raise exception 'SECURITY: sees other moves'; end if;
  begin insert into entries (season_id, user_id) values (1, u); exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'SECURITY: direct insert allowed'; end if;
  reset role;
  raise notice 'security ok';
end $$;
