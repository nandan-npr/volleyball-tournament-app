import { useEffect, useMemo, useState } from "react";
import {
  supabase,
  fetchFullTournament,
  createTournament,
  verifyOrganizer,
  addTeam,
  updateTeam,
  deleteTeam,
  addPlayer,
  updatePlayer,
  deletePlayer,
  setStarters,
  createLeagueFixtures,
  createManualMatch,
  updateMatchScore,
  createKnockoutFixtures,
  createFinal,
  setTournamentWinner
} from "./supabase";
import {
  Trophy,
  Radio,
  Plus,
  Copy,
  LockKeyhole,
  Volleyball,
  CalendarDays,
  MapPin,
  Users,
  Medal,
  ClipboardList,
  CheckCircle2,
  KeyRound,
  ShieldCheck,
  AlertCircle,
  Trash2,
  Edit3,
  UserPlus,
  Play,
  Check,
  X,
  Clock,
  ArrowRight
} from "lucide-react";

// Scoped session storage for organizer credentials (isolated per tournament ID, never global)
const getSessionAdmin = (id) => {
  if (!id) return "";
  try {
    return sessionStorage.getItem(`volley_auth_${id.toUpperCase()}`) || "";
  } catch {
    return "";
  }
};

const saveSessionAdmin = (id, token) => {
  if (!id) return;
  try {
    if (token) {
      sessionStorage.setItem(`volley_auth_${id.toUpperCase()}`, token.trim());
    } else {
      sessionStorage.removeItem(`volley_auth_${id.toUpperCase()}`);
    }
  } catch (err) {
    console.warn("[VolleyLive] sessionStorage error:", err);
  }
};

const clearSessionAdmin = (id) => {
  if (!id) return;
  try {
    sessionStorage.removeItem(`volley_auth_${id.toUpperCase()}`);
  } catch {}
};

// Purge any stale legacy localStorage keys
try {
  Object.keys(localStorage).forEach((k) => {
    if (k.startsWith("volley_admin_")) localStorage.removeItem(k);
  });
} catch {}

function App() {
  const params = new URLSearchParams(location.search);
  const [view, setView] = useState(params.get("id") ? "dashboard" : "home");
  const [tournamentId, setTournamentId] = useState((params.get("id") || "").toUpperCase());
  const [adminToken, setAdminToken] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);
  const [tournament, setTournament] = useState(null);
  const [loadingTournament, setLoadingTournament] = useState(Boolean(params.get("id")));
  const [teams, setTeams] = useState([]);
  const [matches, setMatches] = useState([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [newlyCreatedKey, setNewlyCreatedKey] = useState(null);

  // Discreet Organizer Access Modal state
  const [showOrganizerModal, setShowOrganizerModal] = useState(false);
  const [loginTournamentCode, setLoginTournamentCode] = useState("");
  const [loginKey, setLoginKey] = useState("");
  const [loginError, setLoginError] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);

  // Spectator Roster Modal state
  const [viewingRosterTeam, setViewingRosterTeam] = useState(null);

  // Organizer Dashboard Sub-navigation: 'teams' | 'create_match' | 'matches' | 'scoring'
  const [orgTab, setOrgTab] = useState("teams");

  // Organizer Matches filter: 'all' | 'upcoming' | 'live' | 'completed'
  const [matchFilter, setMatchFilter] = useState("all");

  // Organizer Team editing modals
  const [editingTeam, setEditingTeam] = useState(null);
  const [managingRosterTeam, setManagingRosterTeam] = useState(null);
  const [newPlayerName, setNewPlayerName] = useState("");
  const [newPlayerIsStarter, setNewPlayerIsStarter] = useState(false);
  const [editingPlayer, setEditingPlayer] = useState(null);

  // Organizer Create Match form state
  const [manualMatch, setManualMatch] = useState({
    teamAId: "",
    teamBId: "",
    stage: "league",
    round: "",
    matchNumber: "",
    scheduledTime: ""
  });

  // Dedicated Scoring state
  const [selectedScoringMatchId, setSelectedScoringMatchId] = useState(null);
  const [scoreSets, setScoreSets] = useState([
    { a: "", b: "" },
    { a: "", b: "" },
    { a: "", b: "" }
  ]);
  const [allowCorrection, setAllowCorrection] = useState(false);

  // Load tournament and subscribe to Realtime updates
  useEffect(() => {
    if (!tournamentId) return;
    let isMounted = true;
    setLoadingTournament(true);

    async function loadData() {
      try {
        const data = await fetchFullTournament(tournamentId);
        if (!isMounted) return;
        if (data) {
          setTournament(data.tournament);
          setTeams(data.teams);
          setMatches(data.matches);
        } else {
          setTournament(null);
        }
      } catch (err) {
        console.error("[VolleyLive] Error loading tournament:", err);
        if (isMounted) setMessage(err.message || "Failed to load tournament data.");
      } finally {
        if (isMounted) setLoadingTournament(false);
      }
    }

    loadData();

    // Set up Supabase Realtime subscription across all tournament tables
    const channel = supabase
      .channel(`volley:tournament:${tournamentId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "tournaments" },
        () => loadData()
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "teams" },
        () => loadData()
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "players" },
        () => loadData()
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "matches" },
        () => loadData()
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "match_sets" },
        () => loadData()
      )
      .subscribe((status) => {
        console.log(`[VolleyLive Realtime] Channel status:`, status);
      });

    return () => {
      isMounted = false;
      supabase.removeChannel(channel);
    };
  }, [tournamentId]);

  // Verify organizer credentials with Supabase strictly from sessionStorage scoped to this tournament
  useEffect(() => {
    let isMounted = true;
    async function checkOrganizerStatus() {
      if (!tournamentId) {
        if (isMounted) {
          setAdminToken("");
          setIsAdmin(false);
        }
        return;
      }
      const stored = getSessionAdmin(tournamentId);
      if (stored) {
        try {
          const verified = await verifyOrganizer(tournamentId, stored);
          if (isMounted) {
            if (verified) {
              setAdminToken(stored);
              setIsAdmin(true);
            } else {
              clearSessionAdmin(tournamentId);
              setAdminToken("");
              setIsAdmin(false);
            }
          }
        } catch {
          if (isMounted) {
            clearSessionAdmin(tournamentId);
            setAdminToken("");
            setIsAdmin(false);
          }
        }
      } else {
        if (isMounted) {
          setAdminToken("");
          setIsAdmin(false);
        }
      }
    }
    checkOrganizerStatus();
    return () => {
      isMounted = false;
    };
  }, [tournamentId]);

  // Keep active scoring match sets in sync when a match is selected
  useEffect(() => {
    if (!selectedScoringMatchId) return;
    const match = matches.find((m) => m.id === selectedScoringMatchId);
    if (match) {
      const cur = match.sets || [];
      setScoreSets([
        { a: cur[0]?.a ?? "", b: cur[0]?.b ?? "" },
        { a: cur[1]?.a ?? "", b: cur[1]?.b ?? "" },
        { a: cur[2]?.a ?? "", b: cur[2]?.b ?? "" }
      ]);
      setAllowCorrection(false);
    }
  }, [selectedScoringMatchId, matches]);

  // Calculate league points and tiebreakers
  const standings = useMemo(() => {
    const rows = teams.map((t) => ({
      ...t,
      played: 0,
      wins: 0,
      losses: 0,
      setsFor: 0,
      setsAgainst: 0,
      points: 0
    }));
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));

    matches
      .filter((m) => m.stage === "league" && m.status === "completed")
      .forEach((m) => {
        const a = byId[m.teamA?.id];
        const b = byId[m.teamB?.id];
        if (!a || !b) return;

        a.played++;
        b.played++;
        let wa = 0;
        let wb = 0;

        (m.sets || []).forEach((s) => {
          a.setsFor += s.a;
          a.setsAgainst += s.b;
          b.setsFor += s.b;
          b.setsAgainst += s.a;
          if (s.a > s.b) wa++;
          else if (s.b > s.a) wb++;
        });

        // Volleyball scoring rules:
        // 2-0 win: 3 pts, 0-2 loss: 0 pts
        // 2-1 win: 2 pts, 1-2 loss: 1 pt
        if (wa > wb) {
          a.wins++;
          b.losses++;
          a.points += wb === 1 ? 2 : 3;
          b.points += wb === 1 ? 1 : 0;
        } else if (wb > wa) {
          b.wins++;
          a.losses++;
          b.points += wa === 1 ? 2 : 3;
          a.points += wa === 1 ? 1 : 0;
        }
      });

    return rows.sort(
      (a, b) => b.points - a.points || b.setsFor - b.setsAgainst - (a.setsFor - a.setsAgainst)
    );
  }, [teams, matches]);

  // Partition matches for Spectator View
  const liveMatches = useMemo(() => matches.filter((m) => m.status === "live"), [matches]);
  const completedMatches = useMemo(
    () => matches.filter((m) => m.status === "completed"),
    [matches]
  );
  const upcomingMatches = useMemo(
    () => matches.filter((m) => m.status === "upcoming"),
    [matches]
  );

  // Helper for executing organizer RPC actions
  async function runAction(actionFn, label) {
    setBusy(true);
    setMessage("");
    try {
      const result = await actionFn();
      setMessage(`${label} completed successfully.`);
      const refreshed = await fetchFullTournament(tournamentId);
      if (refreshed) {
        setTournament(refreshed.tournament);
        setTeams(refreshed.teams);
        setMatches(refreshed.matches);
      }
      return result;
    } catch (e) {
      console.error(`[VolleyLive] Error during ${label}:`, e);
      let errMsg = e?.message || "An error occurred.";
      if (
        e?.code === "PGRST202" ||
        (e?.details && e.details.includes("schema cache")) ||
        (e?.message && e.message.includes("schema cache"))
      ) {
        errMsg =
          "Database migration required: The function was not found in your Supabase project (PGRST202). Please execute the migration file 'supabase/migrations/20261107000001_organizer_management_and_scoring.sql' in your Supabase SQL Editor.";
      }
      setMessage(errMsg);
      return null;
    } finally {
      setBusy(false);
    }
  }

  // Create tournament handler
  async function handleCreate(e) {
    e.preventDefault();
    setBusy(true);
    setMessage("");
    const f = new FormData(e.currentTarget);
    try {
      const result = await createTournament({
        name: f.get("name"),
        organizerName: f.get("organizerName"),
        phone: f.get("phone"),
        location: f.get("location"),
        date: f.get("date") || null
      });

      setTournamentId(result.tournamentId);
      setAdminToken(result.adminToken);
      setIsAdmin(true);
      saveSessionAdmin(result.tournamentId, result.adminToken);
      setNewlyCreatedKey(result.adminToken);
      setView("manage");
      history.replaceState({}, "", `?id=${result.tournamentId}`);
    } catch (e) {
      console.error("[VolleyLive] Create tournament failed:", e);
      setMessage(e.message || "Failed to create tournament.");
    } finally {
      setBusy(false);
    }
  }

  // Join tournament handler (enters view-only spectator mode by default)
  async function handleJoin(e) {
    e.preventDefault();
    const id = new FormData(e.currentTarget).get("id").toString().trim().toUpperCase();
    setTournamentId(id);
    const stored = getSessionAdmin(id);
    setAdminToken(stored);
    setView("dashboard");
    history.replaceState({}, "", `?id=${id}`);
  }

  // Add team handler
  async function handleAddTeam(e) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const players = String(f.get("players") || "")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);

    await runAction(
      () =>
        addTeam({
          tournamentCode: tournamentId,
          adminToken,
          name: f.get("name"),
          captain: f.get("captain"),
          players
        }),
      "Add team"
    );
    e.currentTarget.reset();
  }

  // Edit team handler
  async function handleUpdateTeamSubmit(e) {
    e.preventDefault();
    if (!editingTeam) return;
    const f = new FormData(e.currentTarget);
    const res = await runAction(
      () =>
        updateTeam({
          tournamentCode: tournamentId,
          adminToken,
          teamId: editingTeam.id,
          name: f.get("name"),
          captain: f.get("captain")
        }),
      "Update team details"
    );
    if (res) setEditingTeam(null);
  }

  // Delete team handler
  async function handleDeleteTeam(team) {
    if (
      !window.confirm(
        `Are you sure you want to delete team "${team.name}"? This action cannot be undone.`
      )
    )
      return;

    await runAction(
      () =>
        deleteTeam({
          tournamentCode: tournamentId,
          adminToken,
          teamId: team.id
        }),
      "Delete team"
    );
  }

  // Add individual player to team
  async function handleAddPlayerToTeam(e) {
    e.preventDefault();
    if (!managingRosterTeam || !newPlayerName.trim()) return;

    const res = await runAction(
      () =>
        addPlayer({
          tournamentCode: tournamentId,
          adminToken,
          teamId: managingRosterTeam.id,
          playerName: newPlayerName,
          isStarter: newPlayerIsStarter
        }),
      "Add player"
    );

    if (res) {
      setNewPlayerName("");
      setNewPlayerIsStarter(false);
      // Refresh managing team roster view
      const updated = teams.find((t) => t.id === managingRosterTeam.id);
      if (updated) setManagingRosterTeam(updated);
    }
  }

  // Toggle starter status for a player
  async function handleToggleStarter(player) {
    if (!managingRosterTeam) return;
    await runAction(
      () =>
        updatePlayer({
          tournamentCode: tournamentId,
          adminToken,
          playerId: player.id,
          playerName: player.name,
          isStarter: !player.is_starter
        }),
      "Update starter status"
    );
  }

  // Delete player
  async function handleDeletePlayer(player) {
    if (!managingRosterTeam) return;
    if (!window.confirm(`Delete player "${player.name}"?`)) return;

    await runAction(
      () =>
        deletePlayer({
          tournamentCode: tournamentId,
          adminToken,
          playerId: player.id
        }),
      "Delete player"
    );
  }

  // Create manual match handler
  async function handleCreateManualMatchSubmit(e) {
    e.preventDefault();
    if (manualMatch.teamAId === manualMatch.teamBId) {
      setMessage("Team A and Team B cannot be the same team.");
      return;
    }

    const nextMatchNumber =
      manualMatch.matchNumber ||
      (matches.length > 0 ? Math.max(...matches.map((m) => m.matchNumber || 0)) + 1 : 1);

    const res = await runAction(
      () =>
        createManualMatch({
          tournamentCode: tournamentId,
          tournamentUuid: tournament?.id,
          adminToken,
          teamAId: manualMatch.teamAId,
          teamBId: manualMatch.teamBId,
          stage: manualMatch.stage,
          round: manualMatch.round || `${manualMatch.stage.toUpperCase()} Match ${nextMatchNumber}`,
          matchNumber: Number(nextMatchNumber),
          scheduledTime: manualMatch.scheduledTime
        }),
      "Schedule match"
    );

    if (res) {
      setManualMatch({
        teamAId: "",
        teamBId: "",
        stage: "league",
        round: "",
        matchNumber: "",
        scheduledTime: ""
      });
      setOrgTab("matches");
    }
  }

  // Submit match scores from dedicated scoring view
  async function handleSaveScore(e) {
    e.preventDefault();
    const scoringMatch = matches.find((m) => m.id === selectedScoringMatchId);
    if (!scoringMatch) return;

    const sets = [];
    for (let i = 0; i < 3; i++) {
      const s = scoreSets[i];
      if (s.a === "" || s.b === "" || isNaN(Number(s.a)) || isNaN(Number(s.b))) break;
      sets.push({ a: Number(s.a), b: Number(s.b) });
      const wa = sets.filter((x) => x.a > x.b).length;
      const wb = sets.filter((x) => x.b > x.a).length;
      if (wa === 2 || wb === 2) break;
    }

    if (sets.length === 0) {
      setMessage("Please enter valid points for at least Set 1.");
      return;
    }

    await runAction(
      () =>
        updateMatchScore({
          tournamentCode: tournamentId,
          adminToken,
          matchIdentifier: scoringMatch.matchIdentifier || scoringMatch.match_identifier,
          matchId: scoringMatch.id,
          sets,
          allowCompletedEdit: allowCorrection
        }),
      "Save match score"
    );
  }

  // Discreet Organizer Access submit handler
  async function handleOrganizerLoginSubmit(e) {
    e.preventDefault();
    setLoginBusy(true);
    setLoginError("");

    const targetCode = (loginTournamentCode || tournamentId || "").trim().toUpperCase();
    const targetKey = loginKey.trim();

    if (!targetCode) {
      setLoginError("Please enter a valid Tournament ID.");
      setLoginBusy(false);
      return;
    }
    if (!targetKey) {
      setLoginError("Please enter your private organizer key.");
      setLoginBusy(false);
      return;
    }

    try {
      const valid = await verifyOrganizer(targetCode, targetKey);
      if (valid) {
        saveSessionAdmin(targetCode, targetKey);
        setAdminToken(targetKey);
        setIsAdmin(true);
        if (tournamentId !== targetCode) {
          setTournamentId(targetCode);
          history.replaceState({}, "", `${location.pathname}?id=${targetCode}`);
        }
        setView("manage");
        setShowOrganizerModal(false);
        setLoginKey("");
        setMessage(`Organizer dashboard unlocked for Tournament ${targetCode}.`);
      } else {
        setLoginError(`Invalid organizer key for tournament "${targetCode}". Access denied.`);
      }
    } catch (err) {
      console.error("[VolleyLive] Verification error:", err);
      setLoginError(err.message || "Key verification failed. Please check your credentials.");
    } finally {
      setLoginBusy(false);
    }
  }

  // Lock and exit organizer mode immediately
  function handleLogoutOrganizer() {
    clearSessionAdmin(tournamentId);
    setAdminToken("");
    setIsAdmin(false);
    setView("dashboard");
    setMessage("Organizer mode locked. Switched to public spectator scoreboard.");
  }

  async function copyLink() {
    const url = `${location.origin}${location.pathname}?id=${tournamentId}`;
    await navigator.clipboard.writeText(url);
    setMessage("Tournament link copied to clipboard.");
  }

  async function copyOrganizerKey(key) {
    await navigator.clipboard.writeText(key);
    setMessage("Organizer key copied to clipboard. Keep it secure!");
  }

  // Filtered matches for organizer match tab
  const filteredOrganizerMatches = useMemo(() => {
    if (matchFilter === "all") return matches;
    return matches.filter((m) => m.status === matchFilter);
  }, [matches, matchFilter]);

  // Discreet Organizer Access Modal Component
  const renderOrganizerModal = () => {
    if (!showOrganizerModal) return null;
    return (
      <div className="modal-backdrop" onClick={() => setShowOrganizerModal(false)}>
        <div className="modal-window" onClick={(e) => e.stopPropagation()} style={{ maxWidth: "460px" }}>
          <div className="modal-top">
            <div style={{ display: "flex", alignItems: "center", gap: "9px" }}>
              <KeyRound size={20} style={{ color: "#c9f36a" }} />
              <h3 style={{ margin: 0, fontSize: "18px" }}>Organizer Access</h3>
            </div>
            <button
              className="close-modal-btn"
              type="button"
              onClick={() => setShowOrganizerModal(false)}
            >
              ✕
            </button>
          </div>

          <p className="muted" style={{ margin: "0 0 16px", fontSize: "13px", lineHeight: "1.5" }}>
            Enter your tournament ID and private organizer key. Access will be cryptographically verified by the database server.
          </p>

          {loginError && (
            <div
              className="notice warning"
              style={{
                marginBottom: "16px",
                background: "rgba(239, 68, 68, 0.15)",
                color: "#fca5a5",
                borderColor: "#ef4444"
              }}
            >
              <AlertCircle size={15} style={{ display: "inline", verticalAlign: "middle", marginRight: "6px" }} />
              {loginError}
            </div>
          )}

          <form onSubmit={handleOrganizerLoginSubmit} className="form">
            <label className="field">
              <span>Tournament ID</span>
              <input
                type="text"
                placeholder="e.g. 4F2A91BC"
                value={loginTournamentCode}
                onChange={(e) => setLoginTournamentCode(e.target.value.toUpperCase())}
                required
              />
            </label>

            <label className="field">
              <span>Private Organizer Key</span>
              <input
                type="password"
                placeholder="e.g. adm_..."
                value={loginKey}
                onChange={(e) => setLoginKey(e.target.value)}
                required
                autoFocus
              />
            </label>

            <div style={{ display: "flex", gap: "10px", marginTop: "10px" }}>
              <button
                type="button"
                className="secondary"
                style={{ flex: 1 }}
                onClick={() => setShowOrganizerModal(false)}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="primary"
                style={{ flex: 1 }}
                disabled={loginBusy}
              >
                {loginBusy ? "Verifying…" : "Unlock Dashboard"} <LockKeyhole size={15} />
              </button>
            </div>
          </form>
        </div>
      </div>
    );
  };

  // View: Home
  if (view === "home")
    return (
      <main className="shell">
        <header className="brand">
          <div className="brand-icon">
            <Volleyball />
          </div>
          <span>
            Volley<span className="accent">Live</span>
          </span>
        </header>
        <section className="hero">
          <div className="eyebrow">
            <Radio size={15} /> TOURNAMENTS, LIVE
          </div>
          <h1>
            Your game.
            <br />
            <span className="accent">Your scoreboard.</span>
          </h1>
          <p>
            Create a volleyball tournament, manage teams and fixtures, and share live scores with everyone.
          </p>
          <div className="hero-actions">
            <button className="primary" onClick={() => setView("create")}>
              <Plus size={18} /> Create tournament
            </button>
            <button className="secondary" onClick={() => setView("join")}>
              <Radio size={18} /> View tournament
            </button>
            <button
              className="discreet-org-btn"
              style={{ padding: "13px 18px", fontSize: "14px" }}
              onClick={() => {
                setLoginTournamentCode("");
                setLoginKey("");
                setLoginError("");
                setShowOrganizerModal(true);
              }}
              type="button"
            >
              <LockKeyhole size={15} /> Organizer Access
            </button>
          </div>
        </section>
        <section className="feature-grid">
          <Feature
            icon={<Users />}
            title="Team management"
            desc="Four teams, six starting players plus substitutes."
          />
          <Feature
            icon={<ClipboardList />}
            title="League + knockout"
            desc="Round-robin fixtures followed by semi-finals and final."
          />
          <Feature
            icon={<Radio />}
            title="Live scoring"
            desc="Spectators see score updates as they happen."
          />
        </section>
        <footer style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "10px" }}>
          <span>VOLLEYLIVE · PROFESSIONAL VOLLEYBALL SCOREBOARDS</span>
          <button
            className="discreet-org-btn"
            style={{ fontSize: "11px", padding: "4px 9px" }}
            onClick={() => {
              setLoginTournamentCode("");
              setLoginKey("");
              setLoginError("");
              setShowOrganizerModal(true);
            }}
            type="button"
          >
            <LockKeyhole size={12} /> Organizer Login
          </button>
        </footer>
        {renderOrganizerModal()}
      </main>
    );

  // View: Create Tournament
  if (view === "create")
    return (
      <main className="shell narrow">
        <TopBar onBack={() => setView("home")} title="Create tournament" />
        <form className="panel form" onSubmit={handleCreate}>
          <p className="muted">
            Organizer details are required. Your private organizer key is generated automatically and verified cryptographically on the server.
          </p>
          <Field
            label="Tournament name"
            name="name"
            placeholder="e.g. Village Volleyball Cup"
            required
          />
          <Field
            label="Organizer name"
            name="organizerName"
            placeholder="Your full name"
            required
          />
          <Field
            label="Mobile number"
            name="phone"
            placeholder="10-digit mobile number"
            required
          />
          <Field
            label="Tournament location"
            name="location"
            placeholder="Village / town / district"
            required
          />
          <Field label="Tournament date" name="date" type="date" />
          <div className="info-strip">
            <LockKeyhole size={17} /> Only your private organizer key can make changes. The public Tournament ID is view-only for spectators.
          </div>
          {message && <p className="notice">{message}</p>}
          <button className="primary full" disabled={busy}>
            {busy ? "Creating…" : "Create tournament"} <Plus size={17} />
          </button>
        </form>
      </main>
    );

  // View: Join / Search
  if (view === "join")
    return (
      <main className="shell narrow">
        <TopBar onBack={() => setView("home")} title="Find a tournament" />
        <form className="panel form" onSubmit={handleJoin}>
          <div className="center-icon">
            <Trophy size={28} />
          </div>
          <h2>Enter Tournament ID</h2>
          <p className="muted">Ask the organizer for the tournament's public 8-character ID.</p>
          <Field label="Tournament ID" name="id" placeholder="e.g. 4F2A91BC" required />
          {message && <p className="notice">{message}</p>}
          <button className="primary full">
            View live tournament <Radio size={17} />
          </button>
        </form>
        <div style={{ textAlign: "center", marginTop: "20px" }}>
          <button
            className="discreet-org-btn"
            onClick={() => {
              setLoginTournamentCode("");
              setLoginKey("");
              setLoginError("");
              setShowOrganizerModal(true);
            }}
            type="button"
          >
            <LockKeyhole size={13} /> Are you an organizer? Access dashboard
          </button>
        </div>
        {renderOrganizerModal()}
      </main>
    );

  // View: Dashboard & Management
  return (
    <main className="shell wide">
      <TopBar
        onBack={() => {
          setView("home");
          setTournamentId("");
          history.replaceState({}, "", location.pathname);
        }}
        title={
          isAdmin
            ? view === "manage"
              ? "Organizer Dashboard"
              : "Spectator Scoreboard"
            : "Tournament Scoreboard"
        }
        action={
          !isAdmin ? (
            <button
              className="discreet-org-btn"
              onClick={() => {
                setLoginTournamentCode(tournamentId);
                setLoginKey("");
                setLoginError("");
                setShowOrganizerModal(true);
              }}
              type="button"
            >
              <LockKeyhole size={13} /> Organizer Access
            </button>
          ) : (
            <button
              className="lock-logout-btn"
              style={{ padding: "5px 10px", fontSize: "11px" }}
              onClick={handleLogoutOrganizer}
              type="button"
              title="Lock & Exit Organizer Mode"
            >
              <LockKeyhole size={12} /> Lock & Exit
            </button>
          )
        }
      />

      {!tournament ? (
        <div className="panel empty">
          <Trophy size={32} />
          <h2>{loadingTournament ? "Loading tournament…" : "Tournament not found"}</h2>
          <p>
            {loadingTournament
              ? "Connecting to live Supabase tournament data."
              : "Check the Tournament ID and try again."}
          </p>
          {!loadingTournament && (
            <button className="secondary" onClick={() => setView("join")}>
              Enter another ID
            </button>
          )}
        </div>
      ) : (
        <>
          {/* 1. TOURNAMENT HEADER */}
          <section className="tournament-head">
            <div>
              <div className="eyebrow">
                <span className="live-dot" /> {tournament.status?.toUpperCase() || "REGISTRATION"}
              </div>
              <h1>{tournament.name}</h1>
              <div className="meta">
                <span>
                  <MapPin size={15} />
                  {tournament.location}
                </span>
                <span>
                  <CalendarDays size={15} />
                  {tournament.tournament_date || "Date not set"}
                </span>
                <span>
                  <Users size={15} />
                  {teams.length} Teams
                </span>
                <span>
                  <Volleyball size={15} />
                  {matches.length} Matches {liveMatches.length > 0 && `(${liveMatches.length} Live)`}
                </span>
              </div>
            </div>
            <div className="id-card">
              <small>TOURNAMENT ID</small>
              <strong>{tournament.tournament_code}</strong>
              <button className="copy-btn" onClick={copyLink}>
                <Copy size={14} /> Share link
              </button>
            </div>
          </section>

          {/* One-time Organizer Key Banner after tournament creation */}
          {newlyCreatedKey && (
            <div
              className="panel"
              style={{
                border: "2px solid #c9f36a",
                background: "rgba(201, 243, 106, 0.08)",
                marginBottom: "20px"
              }}
            >
              <div style={{ display: "flex", gap: "12px", alignItems: "flex-start" }}>
                <KeyRound size={28} style={{ color: "#c9f36a", flexShrink: 0, marginTop: "2px" }} />
                <div style={{ flex: 1 }}>
                  <h3 style={{ margin: "0 0 6px", color: "#c9f36a" }}>
                    Save Your Private Organizer Key!
                  </h3>
                  <p style={{ margin: "0 0 10px", fontSize: "13px", color: "#e2e8f0" }}>
                    This key grants full administrative control. It is cryptographically hashed in Supabase and cannot be recovered if lost:
                  </p>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "10px",
                      background: "#0d1828",
                      padding: "8px 12px",
                      borderRadius: "8px",
                      border: "1px solid #34455c"
                    }}
                  >
                    <code style={{ fontSize: "14px", color: "#c9f36a", wordBreak: "break-all" }}>
                      {newlyCreatedKey}
                    </code>
                    <button
                      className="primary"
                      type="button"
                      style={{ padding: "6px 12px", fontSize: "12px", marginLeft: "auto", flexShrink: 0 }}
                      onClick={() => copyOrganizerKey(newlyCreatedKey)}
                    >
                      <Copy size={13} /> Copy Key
                    </button>
                  </div>
                </div>
                <button
                  className="secondary"
                  style={{ padding: "4px 8px", fontSize: "12px" }}
                  onClick={() => setNewlyCreatedKey(null)}
                >
                  ✕ Dismiss
                </button>
              </div>
            </div>
          )}

          {/* Tournament Champion Banner */}
          {tournament.winner_name && (
            <div className="winner-banner">
              <Trophy />
              <div>
                <small>TOURNAMENT CHAMPIONS</small>
                <strong>{tournament.winner_name}</strong>
              </div>
            </div>
          )}

          {/* Global notification banner */}
          {message && <div className="notice global-notice">{message}</div>}

          {/* Organizer Control Bar: ONLY rendered when organizer is authenticated */}
          {isAdmin && (
            <div className="org-status-bar">
              <span className="org-mode-tag">
                <ShieldCheck size={16} /> Organizer Mode Active
              </span>
              <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                <div className="tabs" style={{ margin: 0 }}>
                  <button
                    className={view === "dashboard" ? "active" : ""}
                    onClick={() => setView("dashboard")}
                  >
                    <Radio size={14} style={{ display: "inline", verticalAlign: "middle", marginRight: "4px" }} />
                    Spectator View
                  </button>
                  <button
                    className={view === "manage" ? "active" : ""}
                    onClick={() => setView("manage")}
                  >
                    <ShieldCheck size={14} style={{ display: "inline", verticalAlign: "middle", marginRight: "4px" }} />
                    Organizer Dashboard
                  </button>
                </div>
                <button
                  className="lock-logout-btn"
                  onClick={handleLogoutOrganizer}
                  type="button"
                >
                  <LockKeyhole size={13} /> Lock & Exit
                </button>
              </div>
            </div>
          )}

          {/* ================================================================= */}
          {/* PART 1: PUBLIC SPECTATOR TOURNAMENT VIEW                          */}
          {/* ================================================================= */}
          {(view === "dashboard" || !isAdmin) && (
            <div>
              {/* 2. TEAMS SECTION */}
              <section className="panel" style={{ marginBottom: "24px" }}>
                <div className="section-heading">
                  <div>
                    <h2>Teams & Rosters</h2>
                    <p className="muted">Click any team to inspect its full lineup and starting 6</p>
                  </div>
                  <Users />
                </div>
                {teams.length ? (
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
                      gap: "14px"
                    }}
                  >
                    {teams.map((t, idx) => {
                      const startersCount = (t.playersList || []).filter((p) => p.is_starter).length;
                      return (
                        <div
                          key={t.id}
                          className="team-card-interactive"
                          onClick={() => setViewingRosterTeam(t)}
                        >
                          <div className="team-head">
                            <span className="team-number">{idx + 1}</span>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <strong style={{ fontSize: "16px", display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                {t.name}
                              </strong>
                              <small style={{ color: "#94a3b8" }}>
                                Captain: {t.captain || "Not appointed"}
                              </small>
                            </div>
                          </div>
                          <div style={{ display: "flex", gap: "6px", alignItems: "center", marginTop: "4px" }}>
                            <span className="starter-tag">{startersCount || 6} Starters</span>
                            <span className="sub-tag">
                              {Math.max(0, (t.players?.length || 0) - (startersCount || 6))} Subs
                            </span>
                            <span style={{ marginLeft: "auto", fontSize: "11px", color: "#c9f36a", fontWeight: 700 }}>
                              View Lineup →
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="muted">No teams have registered yet.</p>
                )}
              </section>

              {/* 3. LIVE MATCHES SECTION (Cricbuzz Style) */}
              <section className="panel" style={{ marginBottom: "24px" }}>
                <div className="section-heading">
                  <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                    <h2>Live Matches</h2>
                    {liveMatches.length > 0 && <span className="pulse-live">LIVE NOW</span>}
                  </div>
                  <Radio style={{ color: liveMatches.length ? "#ef4444" : "#94a3b8" }} />
                </div>

                {liveMatches.length ? (
                  <div style={{ display: "grid", gap: "16px" }}>
                    {liveMatches.map((m) => {
                      const sets = m.sets || [];
                      let wa = 0;
                      let wb = 0;
                      sets.forEach((s) => {
                        if (s.a > s.b) wa++;
                        else if (s.b > s.a) wb++;
                      });
                      const currentSetIndex = Math.min(2, sets.length > 0 ? sets.length - 1 : 0);
                      const currentSet = sets[currentSetIndex] || { a: 0, b: 0 };

                      return (
                        <div key={m.id} className="scoreboard-live-hero">
                          <div className="scoreboard-top">
                            <span>
                              {m.round || m.stage} · Match {m.matchNumber}
                            </span>
                            <span className="pulse-live">SET {currentSetIndex + 1} IN PROGRESS</span>
                          </div>

                          <div className="scoreboard-grid">
                            {/* Team A */}
                            <div className="team-col">
                              <strong>{m.teamA?.name || "TBD"}</strong>
                              <span className="sets-won-badge">
                                {wa} {wa === 1 ? "SET" : "SETS"}
                              </span>
                            </div>

                            {/* Cricbuzz Score Center */}
                            <div className="center-score-box">
                              <span className="live-current-score">
                                {currentSet.a} : {currentSet.b}
                              </span>
                              <span className="live-active-set">SET {currentSetIndex + 1} SCORE</span>
                            </div>

                            {/* Team B */}
                            <div className="team-col right">
                              <strong>{m.teamB?.name || "TBD"}</strong>
                              <span className="sets-won-badge">
                                {wb} {wb === 1 ? "SET" : "SETS"}
                              </span>
                            </div>
                          </div>

                          {/* Completed Sets Breakdown Chips */}
                          <div className="set-breakdown-row">
                            {sets.map((s, idx) => (
                              <div
                                key={idx}
                                className={`set-chip ${idx === currentSetIndex ? "active" : ""}`}
                              >
                                Set {idx + 1}: {s.a}–{s.b}
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="muted">No matches are currently in progress.</p>
                )}
              </section>

              {/* 4. COMPLETED MATCHES SECTION */}
              <section className="panel" style={{ marginBottom: "24px" }}>
                <div className="section-heading">
                  <div>
                    <h2>Completed Matches</h2>
                    <p className="muted">Final match results & set breakdowns</p>
                  </div>
                  <CheckCircle2 />
                </div>

                {completedMatches.length ? (
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "14px" }}>
                    {completedMatches.map((m) => {
                      const sets = m.sets || [];
                      let wa = 0;
                      let wb = 0;
                      sets.forEach((s) => {
                        if (s.a > s.b) wa++;
                        else if (s.b > s.a) wb++;
                      });
                      return (
                        <div key={m.id} className="match-card-completed has-winner">
                          <div style={{ display: "flex", justifyContent: "space-between", fontSize: "11px", color: "#8495aa" }}>
                            <span>{m.round || m.stage} · Match {m.matchNumber}</span>
                            <span style={{ color: "#8cb9ff", fontWeight: 700 }}>FINAL</span>
                          </div>

                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                            <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                              <span style={{ fontWeight: m.winner_id === m.team_a_id ? 800 : 500, color: m.winner_id === m.team_a_id ? "#c9f36a" : "#cbd5e1" }}>
                                {m.teamA?.name || "TBD"} {m.winner_id === m.team_a_id && "🏆"}
                              </span>
                              <span style={{ fontWeight: m.winner_id === m.team_b_id ? 800 : 500, color: m.winner_id === m.team_b_id ? "#c9f36a" : "#cbd5e1" }}>
                                {m.teamB?.name || "TBD"} {m.winner_id === m.team_b_id && "🏆"}
                              </span>
                            </div>
                            <div style={{ textAlign: "right", font: "800 22px 'Space Grotesk'", color: "#c9f36a" }}>
                              {wa} – {wb}
                            </div>
                          </div>

                          <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", borderTop: "1px solid #1f2f44", paddingTop: "10px" }}>
                            {sets.map((s, idx) => (
                              <span key={idx} style={{ fontSize: "11px", background: "#152438", padding: "2px 8px", borderRadius: "4px", color: "#94a3b8" }}>
                                S{idx + 1}: {s.a}-{s.b}
                              </span>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="muted">No matches have completed yet.</p>
                )}
              </section>

              {/* 5. UPCOMING MATCHES SECTION */}
              <section className="panel" style={{ marginBottom: "24px" }}>
                <div className="section-heading">
                  <div>
                    <h2>Upcoming Matches</h2>
                    <p className="muted">Scheduled tournament fixtures</p>
                  </div>
                  <Clock />
                </div>

                {upcomingMatches.length ? (
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "14px" }}>
                    {upcomingMatches.map((m) => (
                      <div key={m.id} className="match-card-upcoming">
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: "11px", color: "#8495aa" }}>
                          <span>{m.round || m.stage} · Match {m.matchNumber}</span>
                          <span style={{ color: "#cbd5e1" }}>UPCOMING</span>
                        </div>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "6px 0" }}>
                          <strong style={{ fontSize: "14px" }}>{m.teamA?.name || "TBD"}</strong>
                          <span style={{ color: "#64748b", fontSize: "11px", fontWeight: 800 }}>VS</span>
                          <strong style={{ fontSize: "14px", textAlign: "right" }}>{m.teamB?.name || "TBD"}</strong>
                        </div>
                        {m.scheduledTime && (
                          <div style={{ fontSize: "11px", color: "#94a3b8", display: "flex", alignItems: "center", gap: "5px" }}>
                            <Clock size={12} /> Scheduled: {m.scheduledTime}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="muted">No upcoming matches scheduled.</p>
                )}
              </section>

              {/* 6. POINTS TABLE */}
              <section className="panel">
                <div className="section-heading">
                  <div>
                    <h2>Points Table</h2>
                    <p className="muted">
                      Official league standings · 3 pts for 2–0 win, 2 pts for 2–1 win, 1 pt for 1–2 loss
                    </p>
                  </div>
                  <Medal />
                </div>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Pos</th>
                        <th>Team</th>
                        <th>P</th>
                        <th>W</th>
                        <th>L</th>
                        <th>Sets W</th>
                        <th>Sets L</th>
                        <th>Diff</th>
                        <th>Pts</th>
                      </tr>
                    </thead>
                    <tbody>
                      {standings.map((r, i) => (
                        <tr key={r.id}>
                          <td><b>{i + 1}</b></td>
                          <td className="team-cell">{r.name}</td>
                          <td>{r.played}</td>
                          <td>{r.wins}</td>
                          <td>{r.losses}</td>
                          <td>{r.setsFor}</td>
                          <td>{r.setsAgainst}</td>
                          <td>
                            {r.setsFor - r.setsAgainst > 0
                              ? `+${r.setsFor - r.setsAgainst}`
                              : r.setsFor - r.setsAgainst}
                          </td>
                          <td>
                            <b style={{ color: "#c9f36a", fontSize: "14px" }}>{r.points}</b>
                          </td>
                        </tr>
                      ))}
                      {!standings.length && (
                        <tr>
                          <td colSpan="9" className="muted">
                            No teams added yet.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </section>

              <p className="footnote">
                <CheckCircle2 size={14} /> Cricbuzz-style live sync: Spectators see points and scores update instantly as matches progress.
              </p>
            </div>
          )}

          {/* ================================================================= */}
          {/* PART 2: ORGANIZER DASHBOARD (Strictly protected by isAdmin check) */}
          {/* ================================================================= */}
          {view === "manage" && isAdmin && (
            <div>
              {/* Four Organizer Sub-Navigation Tabs */}
              <div className="organizer-nav">
                    <button
                      className={`org-tab-btn ${orgTab === "teams" ? "active" : ""}`}
                      onClick={() => setOrgTab("teams")}
                    >
                      <Users size={16} /> A. Teams ({teams.length}/4)
                    </button>
                    <button
                      className={`org-tab-btn ${orgTab === "create_match" ? "active" : ""}`}
                      onClick={() => setOrgTab("create_match")}
                    >
                      <Plus size={16} /> B. Create Match
                    </button>
                    <button
                      className={`org-tab-btn ${orgTab === "matches" ? "active" : ""}`}
                      onClick={() => setOrgTab("matches")}
                    >
                      <ClipboardList size={16} /> C. Matches ({matches.length})
                    </button>
                    <button
                      className={`org-tab-btn ${orgTab === "scoring" ? "active" : ""}`}
                      onClick={() => setOrgTab("scoring")}
                    >
                      <Play size={16} /> D. Scoring
                    </button>
                  </div>

                  {/* --------------------------------------------------------- */}
                  {/* TAB A: TEAMS MANAGEMENT                                    */}
                  {/* --------------------------------------------------------- */}
                  {orgTab === "teams" && (
                    <div style={{ display: "grid", gap: "20px" }}>
                      {/* Create Team Form if under 4 teams */}
                      {teams.length < 4 ? (
                        <section className="panel form">
                          <div className="section-heading">
                            <div>
                              <h2>Register New Team ({teams.length}/4)</h2>
                              <p className="muted">Minimum 6 players required per volleyball team</p>
                            </div>
                            <UserPlus />
                          </div>
                          <form className="subform" onSubmit={handleAddTeam}>
                            <Field label="Team name" name="name" placeholder="e.g. Thunder Spikers" required />
                            <Field label="Captain name" name="captain" placeholder="e.g. Alex Rover" />
                            <label className="field">
                              <span>Players roster (minimum 6, one name per line)</span>
                              <textarea
                                name="players"
                                rows="7"
                                placeholder={"Player 1\nPlayer 2\nPlayer 3\nPlayer 4\nPlayer 5\nPlayer 6\nSubstitute 1"}
                                required
                              />
                            </label>
                            <button className="primary" disabled={busy}>
                              <Plus size={16} /> Register team
                            </button>
                          </form>
                        </section>
                      ) : (
                        <div className="notice" style={{ background: "#132338", color: "#c9f36a", border: "1px solid #233e5c" }}>
                          ✓ Maximum 4 teams registered for this tournament.
                        </div>
                      )}

                      {/* Existing Teams List */}
                      <section className="panel">
                        <div className="section-heading">
                          <div>
                            <h2>Current Registered Teams</h2>
                            <p className="muted">Manage rosters, edit captain names, and designate 6 starters</p>
                          </div>
                          <Users />
                        </div>

                        {teams.length ? (
                          <div style={{ display: "grid", gap: "16px" }}>
                            {teams.map((team, idx) => {
                              const starters = (team.playersList || []).filter((p) => p.is_starter);
                              const subs = (team.playersList || []).filter((p) => !p.is_starter);
                              return (
                                <div
                                  key={team.id}
                                  style={{
                                    background: "#0d1828",
                                    border: "1px solid #24354b",
                                    borderRadius: "12px",
                                    padding: "18px"
                                  }}
                                >
                                  <div
                                    style={{
                                      display: "flex",
                                      justifyContent: "space-between",
                                      alignItems: "flex-start",
                                      marginBottom: "12px",
                                      flexWrap: "wrap",
                                      gap: "10px"
                                    }}
                                  >
                                    <div>
                                      <h3 style={{ margin: "0 0 4px", fontSize: "18px" }}>
                                        {idx + 1}. {team.name}
                                      </h3>
                                      <span style={{ fontSize: "12px", color: "#94a3b8" }}>
                                        Captain: <strong>{team.captain || "None"}</strong> · Total Players: {team.players?.length || 0}
                                      </span>
                                    </div>
                                    <div style={{ display: "flex", gap: "8px" }}>
                                      <button
                                        className="secondary small-btn"
                                        type="button"
                                        onClick={() => setEditingTeam(team)}
                                      >
                                        <Edit3 size={13} /> Edit
                                      </button>
                                      <button
                                        className="primary small-btn"
                                        type="button"
                                        onClick={() => setManagingRosterTeam(team)}
                                      >
                                        <Users size={13} /> Manage Roster
                                      </button>
                                      <button
                                        className="danger-btn small-btn"
                                        type="button"
                                        onClick={() => handleDeleteTeam(team)}
                                      >
                                        <Trash2 size={13} /> Delete
                                      </button>
                                    </div>
                                  </div>

                                  {/* Starters vs Substitutes Summary */}
                                  <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", marginTop: "10px" }}>
                                    <div style={{ flex: 1, minWidth: "220px", background: "#111f30", padding: "10px", borderRadius: "8px" }}>
                                      <strong style={{ fontSize: "11px", color: "#c9f36a", display: "block", marginBottom: "4px" }}>
                                        ★ 6 STARTERS ({starters.length})
                                      </strong>
                                      <div style={{ fontSize: "12px", color: "#cbd5e1", lineHeight: 1.5 }}>
                                        {starters.length > 0
                                          ? starters.map((p) => p.name).join(", ")
                                          : "Defaulting to first 6 players"}
                                      </div>
                                    </div>
                                    <div style={{ flex: 1, minWidth: "220px", background: "#111f30", padding: "10px", borderRadius: "8px" }}>
                                      <strong style={{ fontSize: "11px", color: "#94a3b8", display: "block", marginBottom: "4px" }}>
                                        SUBSTITUTES ({subs.length})
                                      </strong>
                                      <div style={{ fontSize: "12px", color: "#94a3b8", lineHeight: 1.5 }}>
                                        {subs.length > 0 ? subs.map((p) => p.name).join(", ") : "No extra substitutes"}
                                      </div>
                                    </div>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        ) : (
                          <p className="muted">No teams registered yet.</p>
                        )}
                      </section>
                    </div>
                  )}

                  {/* --------------------------------------------------------- */}
                  {/* TAB B: CREATE MATCH                                        */}
                  {/* --------------------------------------------------------- */}
                  {orgTab === "create_match" && (
                    <section className="panel form">
                      <div className="section-heading">
                        <div>
                          <h2>Create Custom Match</h2>
                          <p className="muted">
                            Schedule a match between any two registered teams without duplicating automatic round-robin or knockout fixtures.
                          </p>
                        </div>
                        <Plus />
                      </div>

                      {teams.length < 2 ? (
                        <div className="notice warning">
                          Register at least 2 teams in the Teams tab before scheduling matches.
                        </div>
                      ) : (
                        <form className="subform" onSubmit={handleCreateManualMatchSubmit}>
                          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
                            <label className="field">
                              <span>Team A</span>
                              <select
                                className="field-select"
                                value={manualMatch.teamAId}
                                onChange={(e) => setManualMatch({ ...manualMatch, teamAId: e.target.value })}
                                required
                              >
                                <option value="">Select Team A...</option>
                                {teams.map((t) => (
                                  <option key={t.id} value={t.id} disabled={t.id === manualMatch.teamBId}>
                                    {t.name}
                                  </option>
                                ))}
                              </select>
                            </label>

                            <label className="field">
                              <span>Team B</span>
                              <select
                                className="field-select"
                                value={manualMatch.teamBId}
                                onChange={(e) => setManualMatch({ ...manualMatch, teamBId: e.target.value })}
                                required
                              >
                                <option value="">Select Team B...</option>
                                {teams.map((t) => (
                                  <option key={t.id} value={t.id} disabled={t.id === manualMatch.teamAId}>
                                    {t.name}
                                  </option>
                                ))}
                              </select>
                            </label>
                          </div>

                          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "16px" }}>
                            <label className="field">
                              <span>Stage</span>
                              <select
                                className="field-select"
                                value={manualMatch.stage}
                                onChange={(e) => setManualMatch({ ...manualMatch, stage: e.target.value })}
                              >
                                <option value="league">League</option>
                                <option value="knockout">Knockout</option>
                              </select>
                            </label>

                            <label className="field">
                              <span>Match Number</span>
                              <input
                                type="number"
                                min="1"
                                placeholder={String(matches.length + 1)}
                                value={manualMatch.matchNumber}
                                onChange={(e) => setManualMatch({ ...manualMatch, matchNumber: e.target.value })}
                              />
                            </label>

                            <label className="field">
                              <span>Scheduled Time (Optional)</span>
                              <input
                                type="text"
                                placeholder="e.g. 4:30 PM Court 1"
                                value={manualMatch.scheduledTime}
                                onChange={(e) => setManualMatch({ ...manualMatch, scheduledTime: e.target.value })}
                              />
                            </label>
                          </div>

                          <label className="field">
                            <span>Round Name (Optional)</span>
                            <input
                              type="text"
                              placeholder="e.g. Exhibition Match / Friendly"
                              value={manualMatch.round}
                              onChange={(e) => setManualMatch({ ...manualMatch, round: e.target.value })}
                            />
                          </label>

                          <button className="primary" disabled={busy} type="submit" style={{ marginTop: "10px" }}>
                            {busy ? "Scheduling…" : "Save & Schedule Match"} <Plus size={16} />
                          </button>
                        </form>
                      )}
                    </section>
                  )}

                  {/* --------------------------------------------------------- */}
                  {/* TAB C: MATCHES MANAGEMENT                                  */}
                  {/* --------------------------------------------------------- */}
                  {orgTab === "matches" && (
                    <div style={{ display: "grid", gap: "20px" }}>
                      {/* Automated Tournament Progression Buttons */}
                      <div className="panel" style={{ background: "#111e30" }}>
                        <div className="section-heading">
                          <div>
                            <h2>Automatic Fixture Generation</h2>
                            <p className="muted">Generate tournament round-robin and knockout brackets</p>
                          </div>
                          <Trophy />
                        </div>
                        <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
                          {teams.length === 4 && !matches.some((m) => m.stage === "league") && (
                            <button
                              className="primary"
                              disabled={busy}
                              onClick={() =>
                                runAction(
                                  () => createLeagueFixtures({ tournamentCode: tournamentId, adminToken }),
                                  "Generate 6 league fixtures"
                                )
                              }
                            >
                              Generate 6 league matches
                            </button>
                          )}

                          {matches.filter((m) => m.stage === "league").length === 6 &&
                            matches.filter((m) => m.stage === "league").every((m) => m.status === "completed") &&
                            !matches.some((m) => m.matchIdentifier === "semi_1") && (
                              <button
                                className="primary"
                                disabled={busy}
                                onClick={() =>
                                  runAction(
                                    () => createKnockoutFixtures({ tournamentCode: tournamentId, adminToken }),
                                    "Generate semi-finals"
                                  )
                                }
                              >
                                Generate semi-finals
                              </button>
                            )}

                          {matches.some((m) => m.matchIdentifier === "semi_1") &&
                            matches
                              .filter((m) => m.matchIdentifier === "semi_1" || m.matchIdentifier === "semi_2")
                              .every((m) => m.status === "completed") &&
                            !matches.some((m) => m.matchIdentifier === "final") && (
                              <button
                                className="primary"
                                disabled={busy}
                                onClick={() =>
                                  runAction(
                                    () => createFinal({ tournamentCode: tournamentId, adminToken }),
                                    "Create final match"
                                  )
                                }
                              >
                                Create final match
                              </button>
                            )}

                          {matches.some((m) => m.matchIdentifier === "final" && m.status === "completed") &&
                            !tournament.winner_name && (
                              <button
                                className="primary"
                                disabled={busy}
                                onClick={() =>
                                  runAction(
                                    () => setTournamentWinner({ tournamentCode: tournamentId, adminToken }),
                                    "Confirm tournament winner"
                                  )
                                }
                              >
                                Confirm tournament winner
                              </button>
                            )}
                        </div>
                      </div>

                      {/* Filter Bar */}
                      <section className="panel">
                        <div className="section-heading">
                          <div>
                            <h2>Matches List ({matches.length})</h2>
                            <p className="muted">Filter and manage tournament matches</p>
                          </div>
                          <div className="filter-bar" style={{ margin: 0 }}>
                            <button
                              className={`filter-btn ${matchFilter === "all" ? "active" : ""}`}
                              onClick={() => setMatchFilter("all")}
                            >
                              All ({matches.length})
                            </button>
                            <button
                              className={`filter-btn ${matchFilter === "upcoming" ? "active" : ""}`}
                              onClick={() => setMatchFilter("upcoming")}
                            >
                              Upcoming ({upcomingMatches.length})
                            </button>
                            <button
                              className={`filter-btn ${matchFilter === "live" ? "active" : ""}`}
                              onClick={() => setMatchFilter("live")}
                            >
                              Live ({liveMatches.length})
                            </button>
                            <button
                              className={`filter-btn ${matchFilter === "completed" ? "active" : ""}`}
                              onClick={() => setMatchFilter("completed")}
                            >
                              Completed ({completedMatches.length})
                            </button>
                          </div>
                        </div>

                        {filteredOrganizerMatches.length ? (
                          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "14px" }}>
                            {filteredOrganizerMatches.map((m) => {
                              const sets = m.sets || [];
                              const score = sets.map((s) => `${s.a}–${s.b}`).join("  ");
                              return (
                                <div
                                  key={m.id}
                                  style={{
                                    background: "#0d1828",
                                    border: m.status === "live" ? "2px solid #718e37" : "1px solid #24354b",
                                    borderRadius: "12px",
                                    padding: "16px",
                                    display: "flex",
                                    flexDirection: "column",
                                    gap: "10px"
                                  }}
                                >
                                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: "11px", color: "#8495aa" }}>
                                    <span>
                                      {m.round || m.stage} · Match {m.matchNumber} {m.isManual && "(Custom)"}
                                    </span>
                                    <span className={`status ${m.status}`}>
                                      {m.status === "live" ? "● LIVE" : m.status.toUpperCase()}
                                    </span>
                                  </div>

                                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                                    <strong>{m.teamA?.name || "TBD"}</strong>
                                    <span style={{ fontSize: "10px", color: "#64748b" }}>VS</span>
                                    <strong>{m.teamB?.name || "TBD"}</strong>
                                  </div>

                                  {score && (
                                    <div style={{ fontSize: "12px", color: "#c9f36a", fontWeight: 700 }}>
                                      Sets: {score}
                                    </div>
                                  )}

                                  {m.winnerName && (
                                    <div style={{ fontSize: "12px", color: "#c9f36a" }}>
                                      🏆 Winner: {m.winnerName}
                                    </div>
                                  )}

                                  <button
                                    className="primary"
                                    style={{ marginTop: "6px", padding: "8px 12px", fontSize: "12px" }}
                                    onClick={() => {
                                      setSelectedScoringMatchId(m.id);
                                      setOrgTab("scoring");
                                    }}
                                  >
                                    <Play size={13} /> {m.status === "completed" ? "View / Correct Score" : "Score Match"}
                                  </button>
                                </div>
                              );
                            })}
                          </div>
                        ) : (
                          <p className="muted">No matches match the selected filter.</p>
                        )}
                      </section>
                    </div>
                  )}

                  {/* --------------------------------------------------------- */}
                  {/* TAB D: DEDICATED SCORING INTERFACE                         */}
                  {/* --------------------------------------------------------- */}
                  {orgTab === "scoring" && (
                    <section className="panel form">
                      <div className="section-heading">
                        <div>
                          <h2>Volleyball Scoring Console</h2>
                          <p className="muted">
                            Live match point entry · Sets 1 & 2 to 25 pts, deciding Set 3 to 15 pts · Win by 2
                          </p>
                        </div>
                        <Radio />
                      </div>

                      {/* Match Selection Dropdown */}
                      <label className="field">
                        <span>Select Match to Score</span>
                        <select
                          className="field-select"
                          value={selectedScoringMatchId || ""}
                          onChange={(e) => setSelectedScoringMatchId(e.target.value || null)}
                        >
                          <option value="">Choose a match to score...</option>
                          {matches.map((m) => (
                            <option key={m.id} value={m.id}>
                              Match {m.matchNumber} ({m.round || m.stage}): {m.teamA?.name || "TBD"} vs {m.teamB?.name || "TBD"} [{m.status.toUpperCase()}]
                            </option>
                          ))}
                        </select>
                      </label>

                      {selectedScoringMatchId ? (
                        (() => {
                          const scoringMatch = matches.find((m) => m.id === selectedScoringMatchId);
                          if (!scoringMatch) return null;

                          let calcWinsA = 0;
                          let calcWinsB = 0;
                          scoreSets.forEach((s) => {
                            const a = Number(s.a);
                            const b = Number(s.b);
                            if (s.a !== "" && s.b !== "" && !isNaN(a) && !isNaN(b)) {
                              if (a > b) calcWinsA++;
                              else if (b > a) calcWinsB++;
                            }
                          });

                          return (
                            <form className="subform" onSubmit={handleSaveScore} style={{ marginTop: "16px" }}>
                              <div
                                style={{
                                  display: "flex",
                                  justifyContent: "space-between",
                                  alignItems: "center",
                                  background: "#09121d",
                                  padding: "14px 18px",
                                  borderRadius: "10px",
                                  marginBottom: "14px"
                                }}
                              >
                                <div>
                                  <strong style={{ fontSize: "17px", color: "#f8fafc" }}>
                                    {scoringMatch.teamA?.name || "Team A"}
                                  </strong>
                                  <span style={{ display: "block", fontSize: "11px", color: "#c9f36a" }}>
                                    Sets Won: {calcWinsA}
                                  </span>
                                </div>
                                <span style={{ font: "800 18px 'Space Grotesk'", color: "#64748b" }}>VS</span>
                                <div style={{ textAlign: "right" }}>
                                  <strong style={{ fontSize: "17px", color: "#f8fafc" }}>
                                    {scoringMatch.teamB?.name || "Team B"}
                                  </strong>
                                  <span style={{ display: "block", fontSize: "11px", color: "#c9f36a" }}>
                                    Sets Won: {calcWinsB}
                                  </span>
                                </div>
                              </div>

                              {/* Warning if match is already completed */}
                              {scoringMatch.status === "completed" && (
                                <div className="notice warning" style={{ marginBottom: "14px" }}>
                                  <AlertCircle size={15} style={{ display: "inline", verticalAlign: "middle", marginRight: "6px" }} />
                                  This match is already marked <strong>COMPLETED</strong>. To correct an erroneous score, check the authorized correction box below.
                                </div>
                              )}

                              {/* Set 1, 2, 3 Inputs */}
                              {[0, 1, 2].map((idx) => {
                                const target = idx === 2 ? 15 : 25;
                                return (
                                  <div
                                    key={idx}
                                    style={{
                                      display: "grid",
                                      gridTemplateColumns: "1fr 1fr",
                                      gap: "14px",
                                      background: "#101d2d",
                                      padding: "12px",
                                      borderRadius: "8px",
                                      marginBottom: "10px"
                                    }}
                                  >
                                    <label className="field">
                                      <span>
                                        Set {idx + 1} ({target} pts) — {scoringMatch.teamA?.name}
                                      </span>
                                      <input
                                        type="number"
                                        min="0"
                                        max="99"
                                        placeholder={String(target)}
                                        value={scoreSets[idx].a}
                                        onChange={(e) => {
                                          const next = [...scoreSets];
                                          next[idx] = { ...next[idx], a: e.target.value };
                                          setScoreSets(next);
                                        }}
                                      />
                                    </label>
                                    <label className="field">
                                      <span>
                                        Set {idx + 1} ({target} pts) — {scoringMatch.teamB?.name}
                                      </span>
                                      <input
                                        type="number"
                                        min="0"
                                        max="99"
                                        placeholder={String(target)}
                                        value={scoreSets[idx].b}
                                        onChange={(e) => {
                                          const next = [...scoreSets];
                                          next[idx] = { ...next[idx], b: e.target.value };
                                          setScoreSets(next);
                                        }}
                                      />
                                    </label>
                                  </div>
                                );
                              })}

                              {/* Authorized Correction Checkbox if completed */}
                              {scoringMatch.status === "completed" && (
                                <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "12px", color: "#f8fafc", margin: "10px 0" }}>
                                  <input
                                    type="checkbox"
                                    checked={allowCorrection}
                                    onChange={(e) => setAllowCorrection(e.target.checked)}
                                  />
                                  <span>Authorize score correction on completed match</span>
                                </label>
                              )}

                              <div style={{ display: "flex", gap: "10px", marginTop: "14px" }}>
                                <button
                                  className="primary"
                                  disabled={busy || (scoringMatch.status === "completed" && !allowCorrection)}
                                  type="submit"
                                >
                                  {busy ? "Updating…" : "Save Live Match Score"} <Play size={15} />
                                </button>
                                <button
                                  className="secondary"
                                  type="button"
                                  onClick={() => setSelectedScoringMatchId(null)}
                                >
                                  Cancel
                                </button>
                              </div>
                            </form>
                          );
                        })()
                      ) : (
                        <p className="muted">Please choose a match from the dropdown above to enter or update points.</p>
                      )}
                    </section>
                  )}
                </div>
              )}

          {/* ================================================================= */}
          {/* SPECTATOR MODAL: TEAM ROSTER INSPECTION                          */}
          {/* ================================================================= */}
          {viewingRosterTeam && (
            <div className="modal-backdrop" onClick={() => setViewingRosterTeam(null)}>
              <div className="modal-window" onClick={(e) => e.stopPropagation()}>
                <div className="modal-top">
                  <div>
                    <h2 style={{ margin: "0 0 4px", fontSize: "20px" }}>{viewingRosterTeam.name}</h2>
                    <span style={{ fontSize: "12px", color: "#94a3b8" }}>
                      Captain: <strong>{viewingRosterTeam.captain || "Not appointed"}</strong> · {viewingRosterTeam.players?.length || 0} Players
                    </span>
                  </div>
                  <button className="close-modal-btn" onClick={() => setViewingRosterTeam(null)}>
                    ✕
                  </button>
                </div>

                <div style={{ display: "grid", gap: "18px" }}>
                  {/* Starters Section */}
                  <div>
                    <h4 style={{ color: "#c9f36a", margin: "0 0 10px", fontSize: "13px", letterSpacing: "1px" }}>
                      ★ STARTING SIX PLAYERS
                    </h4>
                    <div style={{ display: "grid", gap: "8px" }}>
                      {(viewingRosterTeam.playersList || [])
                        .filter((p) => p.is_starter)
                        .map((p, idx) => (
                          <div
                            key={p.id}
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              background: "#0d1828",
                              padding: "9px 12px",
                              borderRadius: "8px",
                              border: "1px solid #23344a",
                              alignItems: "center"
                            }}
                          >
                            <span style={{ fontWeight: 600 }}>{idx + 1}. {p.name}</span>
                            <span className="starter-tag">Starter</span>
                          </div>
                        ))}
                    </div>
                  </div>

                  {/* Substitutes Section */}
                  <div>
                    <h4 style={{ color: "#94a3b8", margin: "0 0 10px", fontSize: "13px", letterSpacing: "1px" }}>
                      SUBSTITUTES / RESERVES
                    </h4>
                    <div style={{ display: "grid", gap: "8px" }}>
                      {(viewingRosterTeam.playersList || [])
                        .filter((p) => !p.is_starter)
                        .map((p, idx) => (
                          <div
                            key={p.id}
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              background: "#0d1828",
                              padding: "9px 12px",
                              borderRadius: "8px",
                              border: "1px solid #1e2c3e",
                              alignItems: "center"
                            }}
                          >
                            <span style={{ color: "#cbd5e1" }}>{idx + 7}. {p.name}</span>
                            <span className="sub-tag">Sub</span>
                          </div>
                        ))}
                      {!(viewingRosterTeam.playersList || []).some((p) => !p.is_starter) && (
                        <p className="muted" style={{ fontSize: "12px" }}>No additional substitutes listed.</p>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ================================================================= */}
          {/* ORGANIZER MODAL: EDIT TEAM DETAILS                               */}
          {/* ================================================================= */}
          {editingTeam && (
            <div className="modal-backdrop" onClick={() => setEditingTeam(null)}>
              <div className="modal-window" onClick={(e) => e.stopPropagation()}>
                <div className="modal-top">
                  <h3 style={{ margin: 0 }}>Edit Team Details</h3>
                  <button className="close-modal-btn" onClick={() => setEditingTeam(null)}>✕</button>
                </div>
                <form onSubmit={handleUpdateTeamSubmit} className="subform">
                  <Field label="Team Name" name="name" defaultValue={editingTeam.name} required />
                  <Field label="Captain Name" name="captain" defaultValue={editingTeam.captain || ""} />
                  <div style={{ display: "flex", gap: "10px", marginTop: "10px" }}>
                    <button className="primary" disabled={busy} type="submit">
                      {busy ? "Saving…" : "Save Changes"}
                    </button>
                    <button className="secondary" type="button" onClick={() => setEditingTeam(null)}>
                      Cancel
                    </button>
                  </div>
                </form>
              </div>
            </div>
          )}

          {/* ================================================================= */}
          {/* ORGANIZER MODAL: MANAGE ROSTER & 6 STARTERS                       */}
          {/* ================================================================= */}
          {managingRosterTeam && (
            <div className="modal-backdrop" onClick={() => setManagingRosterTeam(null)}>
              <div className="modal-window" onClick={(e) => e.stopPropagation()} style={{ width: "min(640px, 100%)" }}>
                <div className="modal-top">
                  <div>
                    <h3 style={{ margin: 0 }}>Manage Roster: {managingRosterTeam.name}</h3>
                    <span style={{ fontSize: "12px", color: "#94a3b8" }}>
                      Designate 6 starting players and add substitutes (minimum 6 players required)
                    </span>
                  </div>
                  <button className="close-modal-btn" onClick={() => setManagingRosterTeam(null)}>✕</button>
                </div>

                {/* Add Player Inline Form */}
                <form
                  onSubmit={handleAddPlayerToTeam}
                  style={{
                    display: "flex",
                    gap: "10px",
                    alignItems: "flex-end",
                    marginBottom: "18px",
                    background: "#0d1828",
                    padding: "12px",
                    borderRadius: "10px"
                  }}
                >
                  <label className="field" style={{ flex: 1, margin: 0 }}>
                    <span>New Player Name</span>
                    <input
                      type="text"
                      placeholder="e.g. Jordan Ray"
                      value={newPlayerName}
                      onChange={(e) => setNewPlayerName(e.target.value)}
                      required
                    />
                  </label>
                  <label style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", color: "#cbd5e1", paddingBottom: "10px" }}>
                    <input
                      type="checkbox"
                      checked={newPlayerIsStarter}
                      onChange={(e) => setNewPlayerIsStarter(e.target.checked)}
                    />
                    <span>Starter</span>
                  </label>
                  <button className="primary small-btn" disabled={busy} type="submit" style={{ height: "42px" }}>
                    <Plus size={14} /> Add
                  </button>
                </form>

                {/* Players List with Starter Toggle & Delete */}
                <div style={{ display: "grid", gap: "8px" }}>
                  {(managingRosterTeam.playersList || []).map((player, idx) => (
                    <div
                      key={player.id}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        background: "#0d1828",
                        padding: "10px 14px",
                        borderRadius: "8px",
                        border: player.is_starter ? "1px solid #718e37" : "1px solid #23344a"
                      }}
                    >
                      <div>
                        <strong>{idx + 1}. {player.name}</strong>
                        <span style={{ marginLeft: "10px" }}>
                          {player.is_starter ? (
                            <span className="starter-tag">★ Starting 6</span>
                          ) : (
                            <span className="sub-tag">Substitute</span>
                          )}
                        </span>
                      </div>
                      <div style={{ display: "flex", gap: "6px" }}>
                        <button
                          className="secondary small-btn"
                          type="button"
                          onClick={() => handleToggleStarter(player)}
                          title="Toggle starter / substitute"
                        >
                          {player.is_starter ? "Make Sub" : "Make Starter"}
                        </button>
                        <button
                          className="danger-btn small-btn"
                          type="button"
                          onClick={() => handleDeletePlayer(player)}
                          title="Delete player"
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>

                <div style={{ marginTop: "18px", textAlign: "right" }}>
                  <button className="primary small-btn" onClick={() => setManagingRosterTeam(null)}>
                    Done
                  </button>
                </div>
              </div>
            </div>
          )}
        </>
      )}
      {renderOrganizerModal()}
    </main>
  );
}

function Feature({ icon, title, desc }) {
  return (
    <div className="feature">
      <div>{icon}</div>
      <strong>{title}</strong>
      <p>{desc}</p>
    </div>
  );
}

function TopBar({ onBack, title, action }) {
  return (
    <div className="topbar">
      <button className="back" onClick={onBack}>
        ←
      </button>
      <strong>{title}</strong>
      {action && <div style={{ marginLeft: "auto", marginRight: "12px" }}>{action}</div>}
      <span className="brand-mini" style={{ marginLeft: action ? "0" : "auto" }}>
        VOLLEY<span>LIVE</span>
      </span>
    </div>
  );
}

function Field({ label, name, placeholder, type = "text", required = false, defaultValue = "" }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        name={name}
        type={type}
        placeholder={placeholder}
        required={required}
        defaultValue={defaultValue}
      />
    </label>
  );
}

export default App;
