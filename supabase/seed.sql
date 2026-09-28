-- Season 1: registration open now, starts in 3 days, rounds every 2 hours,
-- live final (last 16, best of 3) on the following day at 13:00 UTC.
insert into public.seasons (name, starts_at, round_minutes, final_size, final_at)
values (
  'Season 1',
  date_trunc('day', now()) + interval '3 days 12 hours',
  120,
  16,
  date_trunc('day', now()) + interval '5 days 13 hours'
);
