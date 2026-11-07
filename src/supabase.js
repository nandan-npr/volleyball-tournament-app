import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn(
    "[VolleyLive] Missing Supabase configuration! Ensure VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY are set."
  );
}

export const supabase = createClient(supabaseUrl || "", supabaseAnonKey || "", {
  auth: {
    persistSession: false
  },
  realtime: {
    params: {
      eventsPerSecond: 10
    }
  }
});

/**
 * Generate a cryptographically secure random organizer key.
 */
export function generateOrganizerKey() {
  const bytes = new Uint8Array(24);
  window.crypto.getRandomValues(bytes);
  return (
    "adm_" +
    Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  );
}

/**
 * Compute SHA-256 lowercase hex string in modern browser environment.
 */
export async function sha256(message) {
  const msgBuffer = new TextEncoder().encode(message.trim());
  const hashBuffer = await window.crypto.subtle.digest("SHA-256", msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Fetch full tournament details, teams, players, matches, and match_sets by tournament code.
 */
export async function fetchFullTournament(tournamentCode) {
  if (!tournamentCode) return null;
  const cleanCode = tournamentCode.trim().toUpperCase();

  // 1. Fetch tournament
  const { data: tournament, error: tErr } = await supabase
    .from("tournaments")
    .select("*")
    .eq("tournament_code", cleanCode)
    .maybeSingle();

  if (tErr) throw tErr;
  if (!tournament) return null;

  // 2. Fetch teams and their players
  const { data: teams, error: teamsErr } = await supabase
    .from("teams")
    .select("*, players(*)")
    .eq("tournament_id", tournament.id)
    .order("created_at", { ascending: true });

  if (teamsErr) throw teamsErr;

  // 3. Fetch matches and their sets
  const { data: matches, error: matchesErr } = await supabase
    .from("matches")
    .select("*, match_sets(*)")
    .eq("tournament_id", tournament.id)
    .order("match_number", { ascending: true });

  if (matchesErr) throw matchesErr;

  return {
    tournament,
    teams: (teams || []).map((t) => {
      const sortedPlayers = (t.players || []).sort((a, b) => {
        if (Boolean(a.is_starter) !== Boolean(b.is_starter)) {
          return a.is_starter ? -1 : 1;
        }
        return (a.player_order || 0) - (b.player_order || 0);
      });

      return {
        ...t,
        playersList: sortedPlayers,
        players: sortedPlayers.map((p) => p.name)
      };
    }),
    matches: (matches || []).map((m) => {
      const teamA = (teams || []).find((t) => t.id === m.team_a_id);
      const teamB = (teams || []).find((t) => t.id === m.team_b_id);
      const sets = (m.match_sets || [])
        .sort((a, b) => a.set_number - b.set_number)
        .map((s) => ({ a: s.team_a_points, b: s.team_b_points }));

      return {
        ...m,
        matchNumber: m.match_number,
        matchIdentifier: m.match_identifier,
        scheduledTime: m.scheduled_time,
        isManual: m.is_manual,
        teamA: teamA ? { id: teamA.id, name: teamA.name } : null,
        teamB: teamB ? { id: teamB.id, name: teamB.name } : null,
        winnerName: m.winner_name,
        sets
      };
    })
  };
}

/**
 * Create a new tournament with cryptographic organizer key hash stored in Supabase.
 */
export async function createTournament({ name, organizerName, phone, location, date }) {
  const adminToken = generateOrganizerKey();
  const tokenHash = await sha256(adminToken);

  const { data, error } = await supabase.rpc("rpc_create_tournament", {
    p_name: name,
    p_organizer_name: organizerName,
    p_phone: phone,
    p_location: location,
    p_date: date || null,
    p_admin_token_hash: tokenHash
  });

  if (error) throw error;

  return {
    tournamentId: data.tournament_code,
    tournamentDbId: data.tournament_id,
    adminToken
  };
}

/**
 * Verify whether an organizer key is valid for a given tournament.
 */
export async function verifyOrganizer(tournamentCode, adminToken) {
  if (!tournamentCode || !adminToken) return false;
  const { data, error } = await supabase.rpc("rpc_verify_organizer", {
    p_tournament_code: tournamentCode.trim().toUpperCase(),
    p_admin_token: adminToken.trim()
  });
  if (error) {
    console.error("[VolleyLive] verifyOrganizer error:", error);
    return false;
  }
  return Boolean(data);
}

/**
 * Add a team with at least 6 players to a tournament.
 */
export async function addTeam({ tournamentCode, adminToken, name, captain, players }) {
  const { data, error } = await supabase.rpc("rpc_add_team", {
    p_tournament_code: tournamentCode.trim().toUpperCase(),
    p_admin_token: adminToken.trim(),
    p_name: name,
    p_captain: captain || null,
    p_players: players
  });
  if (error) throw error;
  return data;
}

/**
 * Helper to fetch internal tournament UUID by code when needed for alternate RPC signatures.
 */
async function getTournamentUuid(tournamentCode) {
  if (!tournamentCode) return null;
  const cleanCode = tournamentCode.trim().toUpperCase();
  const { data } = await supabase
    .from("tournaments")
    .select("id")
    .eq("tournament_code", cleanCode)
    .maybeSingle();
  return data?.id || null;
}

/**
 * Execute an RPC call with fallback to alternate signature if PostgREST reports PGRST202 schema mismatch.
 */
async function callRpcWithFallback(rpcName, primaryPayload, fallbackPayloadFn) {
  const { data, error } = await supabase.rpc(rpcName, primaryPayload);
  if (!error) return data;

  const isMissingRpc =
    error.code === "PGRST202" ||
    (error.message && error.message.includes("schema cache")) ||
    (error.details && error.details.includes("schema cache"));

  if (isMissingRpc && fallbackPayloadFn) {
    try {
      const fallbackPayload = await fallbackPayloadFn();
      if (fallbackPayload) {
        const { data: fbData, error: fbError } = await supabase.rpc(rpcName, fallbackPayload);
        if (!fbError) return fbData;
      }
    } catch (fbErr) {
      console.warn(`[VolleyLive] Alternate signature for ${rpcName} failed:`, fbErr);
    }
  }

  if (isMissingRpc) {
    throw new Error(
      `Database function '${rpcName}' was not found in your Supabase project (PGRST202). Please execute the migration script 'supabase/migrations/20261107000001_organizer_management_and_scoring.sql' in your Supabase SQL Editor.`
    );
  }

  throw error;
}

/**
 * Update team name and captain.
 */
export async function updateTeam({ tournamentCode, adminToken, teamId, name, captain }) {
  const cleanCode = tournamentCode.trim().toUpperCase();
  const token = adminToken.trim();

  return callRpcWithFallback(
    "rpc_update_team",
    {
      p_tournament_code: cleanCode,
      p_admin_token: token,
      p_team_id: teamId,
      p_name: name,
      p_captain: captain || null
    },
    () => ({
      p_admin_token: token,
      p_team_id: teamId,
      p_name: name,
      p_captain: captain || null
    })
  );
}

/**
 * Delete team (safely guarded against scheduled or completed matches).
 */
export async function deleteTeam({ tournamentCode, adminToken, teamId }) {
  const cleanCode = tournamentCode.trim().toUpperCase();
  const token = adminToken.trim();

  return callRpcWithFallback(
    "rpc_delete_team",
    {
      p_tournament_code: cleanCode,
      p_admin_token: token,
      p_team_id: teamId
    },
    () => ({
      p_admin_token: token,
      p_team_id: teamId
    })
  );
}

/**
 * Add a player to an existing team.
 */
export async function addPlayer({ tournamentCode, adminToken, teamId, playerName, isStarter = false }) {
  const cleanCode = tournamentCode.trim().toUpperCase();
  const token = adminToken.trim();

  return callRpcWithFallback(
    "rpc_add_player",
    {
      p_tournament_code: cleanCode,
      p_admin_token: token,
      p_team_id: teamId,
      p_player_name: playerName,
      p_is_starter: isStarter
    },
    () => ({
      p_admin_token: token,
      p_team_id: teamId,
      p_name: playerName,
      p_is_starter: isStarter
    })
  );
}

/**
 * Update player details.
 */
export async function updatePlayer({ tournamentCode, adminToken, playerId, playerName, isStarter }) {
  const cleanCode = tournamentCode.trim().toUpperCase();
  const token = adminToken.trim();

  return callRpcWithFallback(
    "rpc_update_player",
    {
      p_tournament_code: cleanCode,
      p_admin_token: token,
      p_player_id: playerId,
      p_player_name: playerName,
      p_is_starter: isStarter
    },
    () => ({
      p_admin_token: token,
      p_player_id: playerId,
      p_name: playerName,
      p_is_starter: isStarter
    })
  );
}

/**
 * Delete a player from a team (ensuring at least 6 remain).
 */
export async function deletePlayer({ tournamentCode, adminToken, playerId }) {
  const cleanCode = tournamentCode.trim().toUpperCase();
  const token = adminToken.trim();

  return callRpcWithFallback(
    "rpc_delete_player",
    {
      p_tournament_code: cleanCode,
      p_admin_token: token,
      p_player_id: playerId
    },
    () => ({
      p_admin_token: token,
      p_player_id: playerId
    })
  );
}

/**
 * Set the exact 6 starting players for a team.
 */
export async function setStarters({ tournamentCode, adminToken, teamId, starterIds }) {
  const cleanCode = tournamentCode.trim().toUpperCase();
  const token = adminToken.trim();

  return callRpcWithFallback(
    "rpc_set_starters",
    {
      p_tournament_code: cleanCode,
      p_admin_token: token,
      p_team_id: teamId,
      p_starter_ids: starterIds
    },
    () => ({
      p_admin_token: token,
      p_team_id: teamId,
      p_starter_ids: starterIds
    })
  );
}

/**
 * Generate 6 round-robin league matches.
 */
export async function createLeagueFixtures({ tournamentCode, adminToken }) {
  const { data, error } = await supabase.rpc("rpc_create_league_fixtures", {
    p_tournament_code: tournamentCode.trim().toUpperCase(),
    p_admin_token: adminToken.trim()
  });
  if (error) throw error;
  return data;
}

/**
 * Create a manual match fixture between two registered teams.
 */
export async function createManualMatch({
  tournamentCode,
  tournamentUuid,
  adminToken,
  teamAId,
  teamBId,
  stage,
  round,
  matchNumber,
  scheduledTime
}) {
  const cleanCode = tournamentCode.trim().toUpperCase();
  const token = adminToken.trim();
  const cleanStage = (stage || "league").toLowerCase();
  const cleanRound = round || `${cleanStage.toUpperCase()} Match ${matchNumber}`;

  return callRpcWithFallback(
    "rpc_create_manual_match",
    {
      p_tournament_code: cleanCode,
      p_admin_token: token,
      p_team_a_id: teamAId,
      p_team_b_id: teamBId,
      p_stage: cleanStage,
      p_round: cleanRound,
      p_match_number: matchNumber,
      p_scheduled_time: scheduledTime || null
    },
    async () => {
      const tUuid = tournamentUuid || (await getTournamentUuid(cleanCode));
      if (!tUuid) return null;
      return {
        p_admin_token: token,
        p_tournament_id: tUuid,
        p_team1_id: teamAId,
        p_team2_id: teamBId,
        p_stage: cleanStage,
        p_match_number: matchNumber,
        p_scheduled_time: scheduledTime || null
      };
    }
  );
}

/**
 * Update match scores with strict volleyball validation on the server.
 */
export async function updateMatchScore({
  tournamentCode,
  adminToken,
  matchIdentifier,
  matchId,
  sets,
  allowCompletedEdit = false
}) {
  const cleanCode = tournamentCode.trim().toUpperCase();
  const token = adminToken.trim();

  return callRpcWithFallback(
    "rpc_update_match_score",
    {
      p_tournament_code: cleanCode,
      p_admin_token: token,
      p_match_identifier: matchIdentifier,
      p_sets: sets,
      p_allow_completed_edit: allowCompletedEdit
    },
    () => {
      if (!matchId) return null;
      return {
        p_admin_token: token,
        p_match_id: matchId,
        p_set1_t1: sets[0]?.a ?? null,
        p_set1_t2: sets[0]?.b ?? null,
        p_set2_t1: sets[1]?.a ?? null,
        p_set2_t2: sets[1]?.b ?? null,
        p_set3_t1: sets[2]?.a ?? null,
        p_set3_t2: sets[2]?.b ?? null,
        p_allow_completed_edit: allowCompletedEdit
      };
    }
  );
}

/**
 * Generate semi-finals based on league standings.
 */
export async function createKnockoutFixtures({ tournamentCode, adminToken }) {
  const { data, error } = await supabase.rpc("rpc_create_knockout_fixtures", {
    p_tournament_code: tournamentCode.trim().toUpperCase(),
    p_admin_token: adminToken.trim()
  });
  if (error) throw error;
  return data;
}

/**
 * Generate final match between semi-final winners.
 */
export async function createFinal({ tournamentCode, adminToken }) {
  const { data, error } = await supabase.rpc("rpc_create_final", {
    p_tournament_code: tournamentCode.trim().toUpperCase(),
    p_admin_token: adminToken.trim()
  });
  if (error) throw error;
  return data;
}

/**
 * Confirm tournament champion after final match completes.
 */
export async function setTournamentWinner({ tournamentCode, adminToken }) {
  const { data, error } = await supabase.rpc("rpc_set_tournament_winner", {
    p_tournament_code: tournamentCode.trim().toUpperCase(),
    p_admin_token: adminToken.trim()
  });
  if (error) throw error;
  return data;
}
