-- Run the season tick every minute (Supabase: pg_cron is available on all plans, including Free).
create extension if not exists pg_cron;

select cron.schedule('beat-earth-tick', '* * * * *', $$select public.tick()$$);
