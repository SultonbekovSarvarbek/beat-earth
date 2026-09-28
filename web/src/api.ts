import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const configured = Boolean(url && key);
export const supabase: SupabaseClient | null = configured ? createClient(url!, key!) : null;

export type Move = "rock" | "paper" | "scissors";
export type Status = "registration" | "running" | "finished";

export interface Season {
  id: number;
  name: string;
  status: Status;
  starts_at: string;
  round_minutes: number;
  final_size: number;
  final_at: string | null;
  final_move_seconds: number;
  current_round: number;
  finished_at: string | null;
}

export interface Stats {
  season: Season;
  registered: number;
  alive: number;
  countries: { country: string; total: number; alive: number }[];
  champion: { nickname: string; country: string } | null;
}

export interface Game {
  game_no: number;
  mine: Move;
  theirs: Move;
  my_auto: boolean;
  result: "win" | "lose" | "draw";
}

export interface MatchState {
  id: number;
  round: number;
  best_of: number;
  game_no: number;
  starts_at: string;
  deadline: string;
  finished: boolean;
  bye: boolean;
  won: boolean;
  my_wins: number;
  opp_wins: number;
  opponent: { nickname: string; country: string } | null;
  my_move: Move | null;
  games: Game[];
}

export interface MyState {
  profile: { id: string; nickname: string; country: string; lang: string } | null;
  entry: { alive: boolean; eliminated_round: number | null } | null;
  presets: Move[] | null;
  wins: number;
  beaten: { nickname: string; country: string; round: number }[];
  match: MatchState | null;
}

export const MOVES: Move[] = ["rock", "scissors", "paper"];
export const EMOJI: Record<Move, string> = { rock: "✊", scissors: "✌️", paper: "✋" };

function db() {
  if (!supabase) throw new Error("not_configured");
  return supabase;
}

// Postgres exceptions come back as { message: "already_moved" } etc.
function unwrap<T>(res: { data: T; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message);
  return res.data;
}

export async function latestSeasonId(): Promise<number | null> {
  const { data, error } = await db().from("seasons").select("id").order("id", { ascending: false }).limit(1);
  if (error) throw new Error(error.message);
  return data?.[0]?.id ?? null;
}

export const seasonStats = async (season: number) => unwrap(await db().rpc("season_stats", { p_season: season })) as Stats;
export const myState = async (season: number) => unwrap(await db().rpc("my_state", { p_season: season })) as MyState;
export const joinSeason = async (season: number, nickname: string, country: string, lang: string) =>
  unwrap(await db().rpc("join_season", { p_season: season, p_nickname: nickname, p_country: country, p_lang: lang }));
export const submitMove = async (match: number, move: Move) =>
  unwrap(await db().rpc("submit_move", { p_match: match, p_move: move }));
export const setPresets = async (season: number, moves: Move[]) =>
  unwrap(await db().rpc("set_presets", { p_season: season, p_moves: moves }));

export const signInWithGoogle = () =>
  db().auth.signInWithOAuth({ provider: "google", options: { redirectTo: window.location.origin } });
export const signOut = () => db().auth.signOut();

// Round sizes: 1000 → [1000, 500, 250, …, 1]
export function schedule(n: number) {
  const r = [Math.max(n, 1)];
  while (r[r.length - 1] > 1) r.push(Math.ceil(r[r.length - 1] / 2));
  return r;
}
