import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import {
  configured, supabase, latestSeasonId, seasonStats, myState, joinSeason, submitMove, setPresets,
  signInWithGoogle, signOut, schedule, MOVES, EMOJI,
  type Stats, type MyState, type Move, type MatchState,
} from "./api";
import { DICTS, detectLang, makeT, locale, safeSet, type Lang, type Key } from "./i18n";
import { COUNTRY_CODES, countryName, flag, guessCountry, timeZone } from "./countries";

type T = ReturnType<typeof makeT>;

export default function App() {
  const [lang, setLang] = useState<Lang>(detectLang);
  const t = useMemo(() => makeT(lang), [lang]);
  const fmt = useCallback((n: number) => n.toLocaleString(locale(lang)), [lang]);

  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [seasonId, setSeasonId] = useState<number | null | undefined>(undefined);
  const [stats, setStats] = useState<Stats | null>(null);
  const [me, setMe] = useState<MyState | null>(null);
  const [night, setNight] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const now = useNow();

  useEffect(() => { document.documentElement.lang = locale(lang); safeSet("be-lang", lang); }, [lang]);

  const flash = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 2200);
  }, []);
  const showError = useCallback((e: unknown) => {
    const code = e instanceof Error ? e.message : "";
    const key = `err_${code}` as Key;
    setError(key in DICTS[lang] ? t(key) : t("err_generic"));
    window.setTimeout(() => setError(null), 4000);
  }, [lang, t]);

  // auth
  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setAuthReady(true); });
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  // season + stats
  const refreshStats = useCallback(async (id: number) => {
    try { setStats(await seasonStats(id)); } catch (e) { console.error(e); }
  }, []);
  useEffect(() => {
    if (!configured) return;
    latestSeasonId().then(setSeasonId).catch(() => setSeasonId(null));
  }, []);
  useEffect(() => {
    if (!seasonId) return;
    refreshStats(seasonId);
    const iv = window.setInterval(() => refreshStats(seasonId), 30_000);
    return () => window.clearInterval(iv);
  }, [seasonId, refreshStats]);

  // my state
  const refreshMe = useCallback(async () => {
    if (!seasonId || !session) { setMe(null); return; }
    try { setMe(await myState(seasonId)); } catch (e) { console.error(e); }
  }, [seasonId, session]);
  useEffect(() => {
    refreshMe();
    if (!session) return;
    const iv = window.setInterval(refreshMe, 10_000);
    return () => window.clearInterval(iv);
  }, [refreshMe, session]);

  // realtime: my match row + its revealed games + season changes
  const matchId = me?.match?.id;
  useEffect(() => {
    if (!supabase || !seasonId) return;
    const ch = supabase.channel(`be-${seasonId}-${matchId ?? "none"}`)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "seasons", filter: `id=eq.${seasonId}` }, () => { refreshStats(seasonId); refreshMe(); });
    if (matchId) {
      ch.on("postgres_changes", { event: "*", schema: "public", table: "matches", filter: `id=eq.${matchId}` }, refreshMe)
        .on("postgres_changes", { event: "INSERT", schema: "public", table: "games", filter: `match_id=eq.${matchId}` }, refreshMe);
    }
    ch.subscribe();
    return () => { supabase!.removeChannel(ch); };
  }, [seasonId, matchId, refreshMe, refreshStats]);

  const copy = useCallback(async (text: string) => {
    try { await navigator.clipboard.writeText(text); flash(t("copied")); } catch { flash(t("copyFail")); }
  }, [flash, t]);

  // ── pick the screen ───────────────────────────────────────
  let screen: React.ReactNode;
  const season = stats?.season;
  const ctx = { t, fmt, lang, now, stats: stats!, me: me!, copy, showError, refreshMe, flash, seasonId: seasonId! };

  if (!configured) screen = <Notice text={t("notConfigured")} />;
  else if (seasonId === null) screen = <Notice text={t("noSeason")} />;
  else if (!stats || !season || !authReady) screen = <Loading />;
  else if (!session) screen = <Landing {...ctx} />;
  else if (!me) screen = <Loading />;
  else if (!me.entry) screen = season.status === "registration"
    ? <Join {...ctx} defaultNick={nickFromSession(session)} />
    : <Landing {...ctx} />;
  else if (night) screen = <Night {...ctx} onDone={() => setNight(false)} />;
  else if (season.status === "registration") screen = <Lobby {...ctx} onNight={() => setNight(true)} />;
  else if (season.status === "finished") screen = <Finished {...ctx} />;
  else if (!me.entry.alive) screen = <Lost {...ctx} />;
  else if (!me.match) screen = <Waiting {...ctx} onNight={() => setNight(true)} />;
  else if (me.match.finished) screen = <RoundWon {...ctx} match={me.match} onNight={() => setNight(true)} />;
  else if (now < Date.parse(me.match.starts_at)) screen = <FinalCountdown {...ctx} match={me.match} />;
  else screen = <Match {...ctx} match={me.match} />;

  return (
    <div className="wrap">
      <header>
        <div className="logo"><span className="dot" aria-hidden="true" /><span>BEAT EARTH</span></div>
        <div className="row">
          {session && <Profile session={session} t={t} />}
          <div className="langs" role="group" aria-label="Language">
            {(["ru", "en", "zh"] as Lang[]).map((l) => (
              <button key={l} aria-pressed={lang === l} onClick={() => setLang(l)}>{l === "zh" ? "中文" : l.toUpperCase()}</button>
            ))}
          </div>
        </div>
      </header>

      <div className="grid">
        <main className="stage" aria-live="polite" key={String(night)}>{screen}</main>
        {stats && <Side t={t} fmt={fmt} lang={lang} stats={stats} me={me} />}
      </div>

      <section className="how">
        {DICTS[lang].how.map(([a, b]) => <div key={a}><b>{a}</b><p>{b}</p></div>)}
      </section>

      {toast && <div className="toast">{toast}</div>}
      {error && <div className="toast err" role="alert">{error}</div>}
    </div>
  );
}

// ── helpers ─────────────────────────────────────────────────
interface Ctx {
  t: T; fmt: (n: number) => string; lang: Lang; now: number; stats: Stats; me: MyState;
  copy: (s: string) => void; showError: (e: unknown) => void; refreshMe: () => Promise<void>;
  flash: (s: string) => void; seasonId: number;
}

function useNow() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const iv = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(iv); }, []);
  return now;
}

function Profile({ session, t }: { session: Session; t: T }) {
  const m = session.user.user_metadata ?? {};
  const name = (m.full_name || m.name || session.user.email || "Player") as string;
  const email = session.user.email ?? "";
  const avatar = (m.avatar_url || m.picture) as string | undefined;
  const [imgOk, setImgOk] = useState(true);
  return (
    <div className="profile">
      {avatar && imgOk
        ? <img className="avatar" src={avatar} alt="" referrerPolicy="no-referrer" onError={() => setImgOk(false)} />
        : <span className="avatar ph" aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span>}
      <div className="who">
        <b>{name}</b>
        {email && email !== name && <span>{email}</span>}
      </div>
      <button className="logout" onClick={() => signOut()}>{t("signOut")}</button>
    </div>
  );
}

function nickFromSession(s: Session) {
  const name = (s.user.user_metadata?.full_name || s.user.user_metadata?.name || s.user.email || "Player") as string;
  return name.split(/[\s@]/)[0].slice(0, 16);
}

function clock(t: T, ms: number) {
  const sec = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (d ? `${d}${t("dayShort")} ` : "") + [h, m, s].map((x) => String(x).padStart(2, "0")).join(":");
}

const SITE = typeof window !== "undefined" ? window.location.origin : "";
const Loading = () => <div className="center"><span className="spinner" aria-label="Loading" /></div>;
const Notice = ({ text }: { text: string }) => <div className="fade col"><p className="lead">{text}</p></div>;

function GoogleIcon() {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}

// ── screens ─────────────────────────────────────────────────
function Landing({ t, fmt, now, stats }: Ctx) {
  const s = stats.season;
  const reg = s.status === "registration";
  return (
    <div className="fade col">
      <span className="eyebrow">{s.name} · {reg ? t("heroEyebrowReg") : t("heroEyebrowRun")}</span>
      <h1 dangerouslySetInnerHTML={{ __html: t("heroTitle") }} />
      <p className="lead">{t("heroLead")}</p>
      <div className="stats">
        <div className="stat"><b>{fmt(stats.registered)}</b><span>{t("registered")}</span></div>
        <div className="stat"><b>{fmt(stats.countries.length)}</b><span>{t("countries")}</span></div>
        {reg
          ? <div className="stat"><b>{clock(t, Date.parse(s.starts_at) - now)}</b><span>{t("startsIn")}</span></div>
          : <div className="stat"><b>{fmt(stats.alive)}</b><span>{t("alive")}</span></div>}
      </div>
      <div className="row">
        <button className="btn google" onClick={() => signInWithGoogle()}><GoogleIcon />{t("google")}</button>
      </div>
      <p className="note">{t("free")}</p>
    </div>
  );
}

function Join({ t, lang, seasonId, refreshMe, showError, defaultNick }: Ctx & { defaultNick: string }) {
  const [nick, setNick] = useState(defaultNick.length >= 2 ? defaultNick : "");
  const [country, setCountry] = useState(guessCountry);
  const [busy, setBusy] = useState(false);
  const sorted = useMemo(() => [...COUNTRY_CODES].sort((a, b) => countryName(a, lang).localeCompare(countryName(b, lang), lang)), [lang]);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try { await joinSeason(seasonId, nick.trim(), country, lang); await refreshMe(); }
    catch (err) { showError(err); }
    finally { setBusy(false); }
  };
  return (
    <form className="fade col" onSubmit={submit}>
      <h2>{t("joinTitle")}</h2>
      <div className="field">
        <label htmlFor="nick">{t("nick")}</label>
        <input id="nick" value={nick} onChange={(e) => setNick(e.target.value)} minLength={2} maxLength={16} required autoComplete="nickname" />
      </div>
      <div className="field">
        <label htmlFor="country">{t("country")}</label>
        <select id="country" value={country} onChange={(e) => setCountry(e.target.value)}>
          {sorted.map((c) => <option key={c} value={c}>{flag(c)} {countryName(c, lang)}</option>)}
        </select>
      </div>
      <div className="row"><button className="btn" disabled={busy || nick.trim().length < 2}>{t("join")}</button></div>
    </form>
  );
}

function Lobby({ t, fmt, now, stats, me, copy, onNight }: Ctx & { onNight: () => void }) {
  return (
    <div className="fade col">
      <span className="eyebrow">{t("lobbyEyebrow")} · {flag(me.profile?.country)} {me.profile?.nickname}</span>
      <h2>{t("lobbyTitle")}</h2>
      <div className="stats">
        <div className="stat"><b>{clock(t, Date.parse(stats.season.starts_at) - now)}</b><span>{t("startsIn")}</span></div>
        <div className="stat"><b>{fmt(stats.registered)}</b><span>{t("registered")}</span></div>
        <div className="stat"><b>{fmt(stats.countries.length)}</b><span>{t("countries")}</span></div>
      </div>
      <p className="lead">{t("lobbyLead")}</p>
      <div className="row">
        <button className="btn" onClick={() => copy(SITE)}>{t("invite")}</button>
        <button className="btn ghost" onClick={onNight}>{t("nightBtn")}</button>
      </div>
    </div>
  );
}

function Waiting({ t, onNight }: Ctx & { onNight: () => void }) {
  return (
    <div className="fade col">
      <h2>{t("nextRoundSoon")}</h2>
      <div className="row"><button className="btn ghost" onClick={onNight}>{t("nightBtn")}</button></div>
    </div>
  );
}

function Players({ t, lang, me, match, reveal }: { t: T; lang: Lang; me: MyState; match: MatchState; reveal?: [Move, Move] | null }) {
  const o = match.opponent;
  return (
    <div className="vs">
      <div className="player">
        <span className="flag">{flag(me.profile?.country)}</span>
        <span className="name">{me.profile?.nickname}</span>
        <span className="country">{t("you")}</span>
        <div className="hand">{reveal ? EMOJI[reveal[0]] : match.my_move ? EMOJI[match.my_move] : "✊"}</div>
      </div>
      <span className="x">VS</span>
      <div className="player">
        <span className="flag">{flag(o?.country)}</span>
        <span className="name">{o?.nickname ?? "—"}</span>
        <span className="country">{o ? countryName(o.country, lang) : ""}</span>
        <div className="hand">{reveal ? EMOJI[reveal[1]] : "✊"}</div>
      </div>
    </div>
  );
}

function Match({ t, fmt, lang, now, stats, me, match, showError, refreshMe }: Ctx & { match: MatchState }) {
  const [busy, setBusy] = useState(false);
  const deadline = Date.parse(match.deadline);
  const start = Date.parse(match.starts_at);
  const left = Math.max(0, deadline - now);
  const total = Math.max(1, deadline - Math.max(start, deadline - stats.season.round_minutes * 60_000));
  const last = match.games[match.games.length - 1];
  const remaining = schedule(stats.registered)[match.round - 1];
  const expiredRef = useRef(false);

  // when the deadline passes, the server auto-plays within a minute — poll a bit faster
  useEffect(() => {
    if (left === 0 && !expiredRef.current) { expiredRef.current = true; const iv = setInterval(refreshMe, 5000); return () => clearInterval(iv); }
  }, [left, refreshMe]);

  const play = async (m: Move) => {
    setBusy(true);
    try { await submitMove(match.id, m); await refreshMe(); }
    catch (e) { showError(e); await refreshMe(); }
    finally { setBusy(false); }
  };

  return (
    <div className="fade col">
      <div className="row between">
        <span className="eyebrow">{t("round", { r: match.round })} · {t("left", { n: fmt(remaining ?? stats.alive) })}</span>
        {match.best_of > 1 && <span className="pill live">{t("finalBadge")} · {match.my_wins}:{match.opp_wins}</span>}
      </div>
      <Players t={t} lang={lang} me={me} match={match} reveal={!match.my_move && last ? [last.mine, last.theirs] : null} />
      {last && !match.my_move && (
        <div className={`banner ${last.result}`}>
          {last.result === "draw" ? `🤝 ${t("draw")}` : `${last.result === "win" ? "✔" : "✖"} ${t(last.result === "win" ? "won" : "lost")} · ${match.my_wins}:${match.opp_wins}`}
        </div>
      )}
      {match.my_move ? (
        <p className="lead">{t("waiting")}</p>
      ) : (
        <div className="col tight">
          <div className="row between"><h3>{t("yourMove")}</h3><span className="note"><b>{clock(t, left)}</b> {t("timeLeft")}</span></div>
          <div className="timer"><i style={{ width: `${(left / total) * 100}%` }} /></div>
          <div className="moves">
            {MOVES.map((m) => (
              <button key={m} className="move" disabled={busy || left === 0} onClick={() => play(m)}>
                <span className="e">{EMOJI[m]}</span><span className="l">{t(m)}</span>
              </button>
            ))}
          </div>
          <p className="note">{t("autoNote")}</p>
        </div>
      )}
    </div>
  );
}

function FinalCountdown({ t, lang, now, me, match }: Ctx & { match: MatchState }) {
  return (
    <div className="fade col">
      <span className="pill live">{t("finalBadge")}</span>
      <Players t={t} lang={lang} me={me} match={match} />
      <div className="stats one"><div className="stat"><b>{clock(t, Date.parse(match.starts_at) - now)}</b><span>{t("finalStartsIn")}</span></div></div>
    </div>
  );
}

function ShareCard({ t, fmt, lang, me, stats, top, win }: { t: T; fmt: (n: number) => string; lang: Lang; me: MyState; stats: Stats; top: number; win: boolean }) {
  const last = me.beaten.slice(0, 3);
  const more = me.beaten.length - last.length;
  return (
    <div className="card">
      <div className="row between"><span className="eyebrow light">BEAT EARTH · {stats.season.name}</span><span className="cardflag">{flag(me.profile?.country)}</span></div>
      <div className="col tight">
        <span className="cardlabel">{win ? t("cardBeat") : t("cardLost")}</span>
        {win && last.length > 0 && (
          <ul className="beatlist">
            {last.map((o, i) => <li key={i}><span className="bf">{flag(o.country)}</span><span><b>{o.nickname}</b> · {countryName(o.country, lang)}</span></li>)}
            {more > 0 && <li className="more">+{more}</li>}
          </ul>
        )}
        <div className="big">{t("cardTop")} {fmt(top)}</div>
        <span className="cardlabel">{t("cardWorld")} · {fmt(stats.registered)} {t("players")}</span>
      </div>
      <span className="cardnick">@{me.profile?.nickname}</span>
    </div>
  );
}

function LastGames({ t, match }: { t: T; match: MatchState }) {
  if (!match.games.length) return null;
  return (
    <ul className="log">
      {match.games.map((g) => (
        <li key={g.game_no}>
          <span className="mv">{EMOJI[g.mine]} {EMOJI[g.theirs]}</span>
          <span className={`res ${g.result}`}>{g.result === "draw" ? "🤝" : t(g.result === "win" ? "won" : "lost")}{g.my_auto ? ` · ${t("auto")}` : ""}</span>
        </li>
      ))}
    </ul>
  );
}

function RoundWon(props: Ctx & { match: MatchState; onNight: () => void }) {
  const { t, fmt, lang, me, stats, match, copy, onNight } = props;
  const top = schedule(stats.registered)[match.round] ?? stats.alive;
  if (match.bye) {
    return <div className="fade col"><h2>{t("byeTitle")}</h2><p className="lead">{t("byeLead")}</p>
      <div className="row"><button className="btn ghost" onClick={onNight}>{t("nightBtn")}</button></div></div>;
  }
  return (
    <div className="fade col">
      <span className="eyebrow">{t("round", { r: match.round })} ✔ · {flag(match.opponent?.country)} {match.opponent?.nickname}</span>
      <h2>{t("winTitle", { n: fmt(top) })}</h2>
      <LastGames t={t} match={match} />
      <p className="lead">{t("winLead")}</p>
      <ShareCard t={t} fmt={fmt} lang={lang} me={me} stats={stats} top={top} win />
      <div className="row">
        <button className="btn" onClick={() => copy(`${t("shareWin", { r: match.round, n: fmt(top) })} ${SITE}`)}>{t("share")}</button>
        <button className="btn ghost" onClick={onNight}>{t("nightBtn")}</button>
      </div>
    </div>
  );
}

function Lost({ t, fmt, lang, me, stats, copy }: Ctx) {
  const r = me.entry?.eliminated_round ?? 1;
  const reached = schedule(stats.registered)[r - 1] ?? stats.registered;
  return (
    <div className="fade col">
      <span className="eyebrow">{t("lost")} · {me.match?.opponent ? `${flag(me.match.opponent.country)} ${me.match.opponent.nickname}` : ""}</span>
      <h2>{t("loseTitle", { n: fmt(reached) })}</h2>
      {me.match && <LastGames t={t} match={me.match} />}
      <p className="lead">{t("loseLead", { w: me.wins })}</p>
      <ShareCard t={t} fmt={fmt} lang={lang} me={me} stats={stats} top={reached} win={false} />
      <div className="row"><button className="btn" onClick={() => copy(`${t("shareLose", { n: fmt(reached) })} ${SITE}`)}>{t("share")}</button></div>
    </div>
  );
}

function Finished({ t, fmt, lang, me, stats }: Ctx) {
  if (me.entry?.alive) {
    return (
      <div className="fade col">
        <span className="pill gold">🏆 {stats.season.name}</span>
        <h1>{t("champTitle")}</h1>
        <p className="lead">{t("champLead")}</p>
        <ShareCard t={t} fmt={fmt} lang={lang} me={me} stats={stats} top={1} win />
      </div>
    );
  }
  const c = stats.champion;
  return (
    <div className="fade col">
      <span className="pill">🏆 {stats.season.name}</span>
      <h2>{t("spectTitle", { name: c ? `${flag(c.country)} ${c.nickname}` : "—" })}</h2>
      <p className="lead">{t("seasonOver")}</p>
    </div>
  );
}

function Night({ t, me, seasonId, showError, refreshMe, flash, onDone }: Ctx & { onDone: () => void }) {
  type Opt = Move | "random";
  const initial: Opt[] = [0, 1, 2].map((i) => me.presets?.[i] ?? (["rock", "paper", "scissors"] as Move[])[i]);
  const [slots, setSlots] = useState<Opt[]>(initial);
  const [busy, setBusy] = useState(false);
  const ico = (o: Opt) => (o === "random" ? "🎲" : EMOJI[o]);
  const save = async () => {
    setBusy(true);
    // "random" slots are resolved now so the stored preset is a concrete move
    const moves = slots.map((o) => (o === "random" ? MOVES[Math.floor(Math.random() * 3)] : o));
    try { await setPresets(seasonId, moves); await refreshMe(); flash(t("saved")); onDone(); }
    catch (e) { showError(e); }
    finally { setBusy(false); }
  };
  return (
    <div className="fade col night">
      <div className="row"><span className="moon" aria-hidden="true">🌙</span></div>
      <h2>{t("nightTitle")}</h2>
      <p className="lead">{t("nightLead")}</p>
      <div className="slots">
        {slots.map((s, i) => (
          <div className="slot" key={i}>
            <span className="sl">{i + 1}</span>
            <span className="bigico">{ico(s)}</span>
            <div className="opts" role="group" aria-label={`${i + 1}`}>
              {(["rock", "scissors", "paper", "random"] as Opt[]).map((o) => (
                <button key={o} aria-pressed={o === s} title={o === "random" ? t("random") : t(o)}
                  onClick={() => setSlots(slots.map((x, j) => (j === i ? o : x)))}>{ico(o)}</button>
              ))}
            </div>
          </div>
        ))}
      </div>
      <p className="note">{t("quiet", { tz: timeZone() })}</p>
      <div className="row">
        <button className="btn" disabled={busy} onClick={save}>{t("save")}</button>
        <button className="btn ghost" onClick={onDone}>{t("back")}</button>
      </div>
    </div>
  );
}

// ── side panel ──────────────────────────────────────────────
function Side({ t, fmt, lang, stats, me }: { t: T; fmt: (n: number) => string; lang: Lang; stats: Stats; me: MyState | null }) {
  const sched = schedule(stats.registered);
  const s = stats.season;
  const out = me?.entry && !me.entry.alive ? me.entry.eliminated_round ?? 0 : 0;
  const max = Math.max(1, ...stats.countries.map((c) => c.alive));
  const finalAt = s.final_at ? new Date(s.final_at) : null;
  const tf = (d: Date, tz?: string) => d.toLocaleTimeString(locale(lang), { hour: "2-digit", minute: "2-digit", timeZone: tz });
  return (
    <aside>
      <section className="panel">
        <div className="row between"><h3>{t("bracketTitle")}</h3><span className="tag">{s.name}</span></div>
        <ol className="bracket">
          {sched.slice(0, -1).map((n, i) => {
            const r = i + 1;
            const cls = out && r > out ? "out" : r < s.current_round || s.status === "finished" ? "done" : r === s.current_round && s.status === "running" ? "cur" : "";
            return (
              <li key={r} className={cls}>
                <span className="r">R{r}</span><span>{fmt(n)} → {fmt(sched[r])}</span>
                {n <= s.final_size && <span className="tag gold">BO3</span>}
              </li>
            );
          })}
        </ol>
        {finalAt && (
          <div className="finalbox">
            <span className="note">{t("finalLabel")}</span>
            <b>{t("finalLocal", { utc: tf(finalAt, "UTC"), time: tf(finalAt) })}</b>
          </div>
        )}
      </section>
      {stats.countries.length > 0 && (
        <section className="panel">
          <h3>{t("countriesTitle")}</h3>
          <ul className="countries">
            {stats.countries.slice(0, 8).map((c) => (
              <li key={c.country} className={c.country === me?.profile?.country ? "me" : ""}>
                <span>{flag(c.country)}</span><span>{countryName(c.country, lang)}</span><span className="n">{fmt(c.alive)}</span>
                <span className="bar"><i style={{ width: `${(c.alive / max) * 100}%` }} /></span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </aside>
  );
}
