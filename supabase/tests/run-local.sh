#!/usr/bin/env bash
# Runs the migration + a full simulated season against a throwaway local Postgres.
# Usage: PGHOST=... PGPORT=... PGUSER=postgres ./supabase/tests/run-local.sh [players]
set -euo pipefail
cd "$(dirname "$0")/.."
PLAYERS="${1:-1001}"
DB=beat_earth_test
psql -q -v ON_ERROR_STOP=1 -c "drop database if exists $DB" -c "create database $DB"
P="psql -q -v ON_ERROR_STOP=1 -d $DB"
$P <<'SQL'
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
end $$;
create schema auth;
create table auth.users (id uuid primary key default gen_random_uuid());
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
grant usage on schema auth to anon, authenticated;
grant usage on schema public to anon, authenticated;
SQL
$P -f migrations/20260928000000_init.sql
$P -c "grant select on all tables in schema public to anon, authenticated"
$P -v players="$PLAYERS" -f tests/simulate.sql
