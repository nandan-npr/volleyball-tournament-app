import { useEffect, useMemo, useState } from "react";
import { collection, doc, onSnapshot } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { db, functions } from "./firebase";
import { Trophy, Radio, Plus, Copy, LockKeyhole, Volleyball, CalendarDays, MapPin, Users, Medal, ClipboardList, CheckCircle2 } from "lucide-react";

const call = (name, data) => httpsCallable(functions, name)(data).then(r => r.data);
const getStoredAdmin = id => localStorage.getItem(`volley_admin_${id}`) || "";
const saveStoredAdmin = (id, token) => localStorage.setItem(`volley_admin_${id}`, token);

function App() {
  const params = new URLSearchParams(location.search);
  const [view, setView] = useState(params.get("id") ? "join" : "home");
  const [tournamentId, setTournamentId] = useState((params.get("id") || "").toUpperCase());
  const [adminToken, setAdminToken] = useState("");
  const [tournament, setTournament] = useState(null);
  const [teams, setTeams] = useState([]);
  const [matches, setMatches] = useState([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (!tournamentId) return;
    const unsub = onSnapshot(doc(db, "tournaments", tournamentId), snap => setTournament(snap.exists() ? snap.data() : null));
    const unsubTeams = onSnapshot(collection(db, "tournaments", tournamentId, "teams"), snap => setTeams(snap.docs.map(d => d.data())));
    const unsubMatches = onSnapshot(collection(db, "tournaments", tournamentId, "matches"), snap => setMatches(snap.docs.map(d => d.data()).sort((a,b) => (a.matchNumber || 0)-(b.matchNumber || 0))));
    setAdminToken(getStoredAdmin(tournamentId));
    return () => { unsub(); unsubTeams(); unsubMatches(); };
  }, [tournamentId]);

  const standings = useMemo(() => {
    const rows = teams.map(t => ({ ...t, played:0, wins:0, losses:0, setsFor:0, setsAgainst:0, points:0 }));
    const byId = Object.fromEntries(rows.map(r => [r.id,r]));
    matches.filter(m => m.stage === "league" && m.status === "completed").forEach(m => {
      const a=byId[m.teamA?.id], b=byId[m.teamB?.id]; if(!a || !b) return;
      a.played++; b.played++;
      let wa=0, wb=0;
      (m.sets || []).forEach(s => { a.setsFor+=s.a; a.setsAgainst+=s.b; b.setsFor+=s.b; b.setsAgainst+=s.a; if(s.a>s.b) wa++; else wb++; });
      if(wa>wb){a.wins++;b.losses++;a.points += wb===1?2:3;b.points += wb===1?1:0;}
      else{b.wins++;a.losses++;b.points += wa===1?2:3;a.points += wa===1?1:0;}
    });
    return rows.sort((a,b)=>b.points-a.points || (b.setsFor-b.setsAgainst)-(a.setsFor-a.setsAgainst));
  }, [teams,matches]);

  async function run(action, data) {
    setBusy(true); setMessage("");
    try { const result = await call(action, { tournamentId, adminToken, ...data }); setMessage("Saved successfully."); return result; }
    catch (e) { setMessage(e.message || "Something went wrong."); }
    finally { setBusy(false); }
  }

  async function create(e) {
    e.preventDefault(); setBusy(true); setMessage("");
    const f = new FormData(e.currentTarget);
    try {
      const result = await call("createTournament", Object.fromEntries(f.entries()));
      setTournamentId(result.tournamentId); setAdminToken(result.adminToken);
      saveStoredAdmin(result.tournamentId, result.adminToken);
      setView("manage"); history.replaceState({}, "", `?id=${result.tournamentId}`);
    } catch(e) { setMessage(e.message); }
    finally { setBusy(false); }
  }

  async function join(e) {
    e.preventDefault();
    const id = new FormData(e.currentTarget).get("id").toString().trim().toUpperCase();
    setTournamentId(id); setAdminToken(getStoredAdmin(id)); setView("dashboard");
    history.replaceState({}, "", `?id=${id}`);
  }

  async function addTeam(e) {
    e.preventDefault(); const f = new FormData(e.currentTarget);
    const players = String(f.get("players") || "").split("\n").map(s=>s.trim()).filter(Boolean);
    const result = await run("addTeam", { name:f.get("name"), captain:f.get("captain"), players });
    if(result) e.currentTarget.reset();
  }

  async function scoreMatch(match) {
    const current = match.sets?.length ? match.sets : [{a:0,b:0},{a:0,b:0},{a:0,b:0}];
    const ask = (label, value) => window.prompt(label, String(value));
    const sets = [];
    for(let i=0;i<3;i++){
      const a=ask(`Set ${i+1} — ${match.teamA.name} points (leave blank to stop)`, current[i]?.a ?? "");
      if(a === null || a.trim() === "") break;
      const b=ask(`Set ${i+1} — ${match.teamB.name} points`, current[i]?.b ?? "");
      if(b === null || b.trim() === "") break;
      sets.push({a:Number(a),b:Number(b)});
      const wa=sets.filter(s=>s.a>s.b).length, wb=sets.filter(s=>s.b>s.a).length;
      if(wa===2 || wb===2) break;
    }
    if(sets.length) await run("updateMatchScore", { matchId:match.id, sets });
  }

  async function copyLink() {
    const url = `${location.origin}${location.pathname}?id=${tournamentId}`;
    await navigator.clipboard.writeText(url); setMessage("Tournament link copied.");
  }

  if (view === "home") return <main className="shell">
    <header className="brand"><div className="brand-icon"><Volleyball/></div><span>Volley<span className="accent">Live</span></span></header>
    <section className="hero">
      <div className="eyebrow"><Radio size={15}/> TOURNAMENTS, LIVE</div>
      <h1>Your game.<br/><span className="accent">Your scoreboard.</span></h1>
      <p>Create a volleyball tournament, manage teams and fixtures, and share live scores with everyone.</p>
      <div className="hero-actions">
        <button className="primary" onClick={()=>setView("create")}><Plus size={18}/> Create tournament</button>
        <button className="secondary" onClick={()=>setView("join")}><Radio size={18}/> View tournament</button>
      </div>
    </section>
    <section className="feature-grid">
      <Feature icon={<Users/>} title="Team management" desc="Four teams, six players plus substitutes."/>
      <Feature icon={<ClipboardList/>} title="League + knockout" desc="Round-robin fixtures followed by semi-finals and final."/>
      <Feature icon={<Radio/>} title="Live scoring" desc="Spectators see score updates as they happen."/>
    </section>
    <footer>VOLLEYLIVE · SIMPLE TOURNAMENT MANAGEMENT</footer>
  </main>;

  if (view === "create") return <main className="shell narrow">
    <TopBar onBack={()=>setView("home")} title="Create tournament"/>
    <form className="panel form" onSubmit={create}>
      <p className="muted">Organizer details are required. Your private organizer key is generated automatically.</p>
      <Field label="Tournament name" name="name" placeholder="e.g. Village Volleyball Cup" required/>
      <Field label="Organizer name" name="organizerName" placeholder="Your full name" required/>
      <Field label="Mobile number" name="phone" placeholder="10-digit mobile number" required/>
      <Field label="Tournament location" name="location" placeholder="Village / town / district" required/>
      <Field label="Tournament date" name="date" type="date"/>
      <div className="info-strip"><LockKeyhole size={17}/> Only the organizer key can make changes. The public Tournament ID is view-only.</div>
      {message && <p className="notice">{message}</p>}
      <button className="primary full" disabled={busy}>{busy?"Creating…":"Create tournament"} <Plus size={17}/></button>
    </form>
  </main>;

  if (view === "join") return <main className="shell narrow">
    <TopBar onBack={()=>setView("home")} title="Find a tournament"/>
    <form className="panel form" onSubmit={join}>
      <div className="center-icon"><Trophy size={28}/></div>
      <h2>Enter Tournament ID</h2><p className="muted">Ask the organizer for the tournament's public ID.</p>
      <Field label="Tournament ID" name="id" placeholder="e.g. 4F2A91BC" required/>
      {message && <p className="notice">{message}</p>}
      <button className="primary full">View live tournament <Radio size={17}/></button>
    </form>
  </main>;

  return <main className="shell wide">
    <TopBar onBack={()=>{setView("home");setTournamentId("");history.replaceState({}, "", location.pathname);}} title="Tournament dashboard" />
    {!tournament ? <div className="panel empty"><Trophy size={32}/><h2>Tournament not found</h2><p>Check the ID and try again.</p><button className="secondary" onClick={()=>setView("join")}>Enter another ID</button></div> :
    <>
      <section className="tournament-head">
        <div><div className="eyebrow"><span className="live-dot"/> {tournament.status?.toUpperCase() || "REGISTRATION"}</div><h1>{tournament.name}</h1>
        <div className="meta"><span><MapPin size={15}/>{tournament.location}</span><span><CalendarDays size={15}/>{tournament.date || "Date not set"}</span></div></div>
        <div className="id-card"><small>TOURNAMENT ID</small><strong>{tournamentId}</strong><button className="copy-btn" onClick={copyLink}><Copy size={14}/> Share link</button></div>
      </section>
      {tournament.winnerName && <div className="winner-banner"><Trophy/> <div><small>TOURNAMENT CHAMPIONS</small><strong>{tournament.winnerName}</strong></div></div>}
      {message && <div className="notice global-notice">{message}</div>}
      <div className="tabs"><button className={view==="dashboard"?"active":""} onClick={()=>setView("dashboard")}>Overview</button><button onClick={()=>setView("manage")}>Organizer tools</button></div>
      {view === "manage" && <section className="panel form">
        <div className="section-heading"><div><h2>Organizer tools</h2><p className="muted">Only this browser has the organizer key after creation.</p></div><LockKeyhole/></div>
        {!isAdmin ? <div className="notice warning">View-only mode. To edit on another device, an organizer-key recovery flow will be needed. Keep the original organizer device secure.</div> : <>
          <h3>Add team <span className="muted">({teams.length}/4)</span></h3>
          {teams.length < 4 && <form className="subform" onSubmit={addTeam}>
            <Field label="Team name" name="name" placeholder="Team name" required/>
            <Field label="Captain name" name="captain" placeholder="Captain"/>
            <label className="field"><span>Players — one name per line (minimum 6)</span><textarea name="players" rows="7" placeholder={"Player 1\nPlayer 2\nPlayer 3\nPlayer 4\nPlayer 5\nPlayer 6\nSubstitute 1"} required/></label>
            <button className="primary" disabled={busy}><Plus size={16}/> Add team</button>
          </form>}
          {teams.length===4 && !matches.some(m=>m.stage==="league") && <button className="primary" disabled={busy} onClick={()=>run("createLeagueFixtures",{})}>Generate 6 league matches</button>}
          {matches.filter(m=>m.stage==="league").length===6 && matches.filter(m=>m.stage==="league").every(m=>m.status==="completed") && !matches.some(m=>m.id==="semi_1") &&
            <button className="primary" disabled={busy} onClick={()=>run("createKnockoutFixtures",{})}>Generate semi-finals</button>}
          {matches.some(m=>m.id==="semi_1") && matches.filter(m=>m.id==="semi_1"||m.id==="semi_2").every(m=>m.status==="completed") && !matches.some(m=>m.id==="final") &&
            <button className="primary" disabled={busy} onClick={()=>run("createFinal",{})}>Create final</button>}
          {matches.some(m=>m.id==="final"&&m.status==="completed") && !tournament.winnerName &&
            <button className="primary" disabled={busy} onClick={()=>run("setTournamentWinner",{})}>Confirm tournament winner</button>}
        </>}
      </section>}
      <div className="content-grid">
        <section className="panel">
          <div className="section-heading"><div><h2>Teams</h2><p className="muted">Tournament participants</p></div><Users/></div>
          {teams.length ? <div className="team-list">{teams.map((t,i)=><div className="team-row" key={t.id}><span className="team-number">{i+1}</span><div><strong>{t.name}</strong><small>{t.players?.length || 0} players · {t.captain || "Captain not set"}</small></div></div>)}</div> : <p className="muted">Teams will appear here once added.</p>}
        </section>
        <section className="panel">
          <div className="section-heading"><div><h2>Points table</h2><p className="muted">League standings · 3 points for 2–0, 2 for 2–1</p></div><Medal/></div>
          <div className="table-wrap"><table><thead><tr><th>#</th><th>Team</th><th>P</th><th>W</th><th>L</th><th>Pts</th></tr></thead><tbody>
            {standings.map((r,i)=><tr key={r.id}><td>{i+1}</td><td className="team-cell">{r.name}</td><td>{r.played}</td><td>{r.wins}</td><td>{r.losses}</td><td><b>{r.points}</b></td></tr>)}
            {!standings.length && <tr><td colSpan="6" className="muted">No teams yet.</td></tr>}
          </tbody></table></div>
        </section>
      </div>
      <section className="panel">
        <div className="section-heading"><div><h2>Match fixtures & live scores</h2><p className="muted">Best of 3 sets · First two sets to 25, deciding set to 15, win by 2</p></div><Radio/></div>
        {matches.length ? <div className="match-list">{matches.map(m=><MatchCard key={m.id} match={m} isAdmin={isAdmin} onScore={()=>scoreMatch(m)}/>)}</div> : <p className="muted">Fixtures will appear here after the organizer adds four teams and generates the league schedule.</p>}
      </section>
      <p className="footnote"><CheckCircle2 size={14}/> Scores update automatically for everyone viewing this tournament.</p>
    </>}
  </main>;
}

function Feature({icon,title,desc}) { return <div className="feature"><div>{icon}</div><strong>{title}</strong><p>{desc}</p></div>; }
function TopBar({onBack,title}) { return <div className="topbar"><button className="back" onClick={onBack}>←</button><strong>{title}</strong><span className="brand-mini">VOLLEY<span>LIVE</span></span></div>; }
function Field({label,name,placeholder,type="text",required=false}) { return <label className="field"><span>{label}</span><input name={name} type={type} placeholder={placeholder} required={required}/></label>; }
function MatchCard({match,isAdmin,onScore}) {
  const sets = match.sets || [];
  const score = (team) => sets.map(s=>`${team==="a"?s.a:s.b}`).join("  ");
  return <div className={`match-card ${match.status==="live"?"is-live":""}`}>
    <div className="match-top"><span>{match.round || match.stage} · Match {match.matchNumber}</span><span className={`status ${match.status}`}>{match.status==="live"?"● LIVE":match.status}</span></div>
    <div className="match-teams"><div><strong>{match.teamA?.name || "TBD"}</strong><small>{score("a") || "—"}</small></div><span className="versus">VS</span><div className="right"><strong>{match.teamB?.name || "TBD"}</strong><small>{score("b") || "—"}</small></div></div>
    {match.winnerName && <div className="match-winner"><Trophy size={14}/> Winner: {match.winnerName}</div>}
    {isAdmin && <button className="score-button" onClick={onScore}>{match.status==="completed"?"Edit score":"Enter / update score"}</button>}
  </div>;
}

export default App;
