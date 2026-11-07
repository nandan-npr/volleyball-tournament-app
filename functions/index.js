import { onCall, HttpsError } from "firebase-functions/v2/https";
import { initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { randomBytes, createHash } from "node:crypto";

initializeApp();
const db = getFirestore();

const clean = (v, max = 80) => String(v ?? "").trim().slice(0, max);
const hash = (v) => createHash("sha256").update(String(v)).digest("hex");

async function adminTournament(tournamentId, token) {
  const id = clean(tournamentId, 24).toUpperCase();
  if (!id || !token) throw new HttpsError("unauthenticated", "Organizer key required.");
  const ref = db.collection("tournaments").doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "Tournament not found.");
  const privateSnap = await ref.collection("private").doc("organizer").get();
  if (!privateSnap.exists || privateSnap.get("adminTokenHash") !== hash(token)) {
    throw new HttpsError("permission-denied", "Invalid organizer key.");
  }
  return { id, ref, data: snap.data() };
}

export const createTournament = onCall(async (request) => {
  const name = clean(request.data?.name, 80);
  const organizerName = clean(request.data?.organizerName, 80);
  const phone = clean(request.data?.phone, 20);
  const location = clean(request.data?.location, 120);
  const date = clean(request.data?.date, 20);
  if (!name || !organizerName || !phone || !location) {
    throw new HttpsError("invalid-argument", "Tournament name, organizer name, mobile number and location are required.");
  }
  if (!/^[+0-9()\-\s]{7,20}$/.test(phone)) {
    throw new HttpsError("invalid-argument", "Enter a valid mobile number.");
  }

  let id, ref;
  for (let i = 0; i < 5; i++) {
    id = randomBytes(4).toString("hex").toUpperCase();
    ref = db.collection("tournaments").doc(id);
    if (!(await ref.get()).exists) break;
    id = null;
  }
  if (!id) throw new HttpsError("resource-exhausted", "Could not generate an ID. Try again.");

  const adminToken = randomBytes(24).toString("base64url");
  await ref.set({
    id, name, organizerName, location, date,
    format: "League + Knockout",
    teamsLimit: 4,
    matchFormat: "Best of 3",
    status: "registration",
    createdAt: FieldValue.serverTimestamp()
  });
  // Keep the phone number and organizer credential hash outside public tournament data.
  await ref.collection("private").doc("organizer").set({
    phone,
    adminTokenHash: hash(adminToken),
    createdAt: FieldValue.serverTimestamp()
  });
  return { tournamentId: id, adminToken };
});

export const addTeam = onCall(async (request) => {
  const { id, ref } = await adminTournament(request.data?.tournamentId, request.data?.adminToken);
  const name = clean(request.data?.name, 60);
  const captain = clean(request.data?.captain, 60);
  const players = Array.isArray(request.data?.players)
    ? request.data.players.map(p => clean(p, 60)).filter(Boolean).slice(0, 18)
    : [];
  if (!name) throw new HttpsError("invalid-argument", "Team name is required.");
  if (players.length < 6) throw new HttpsError("invalid-argument", "Add at least six players.");
  const teamsRef = ref.collection("teams");
  const existing = await teamsRef.get();
  if (existing.size >= 4) throw new HttpsError("failed-precondition", "This tournament already has four teams.");
  if (existing.docs.some(d => d.get("name").toLowerCase() === name.toLowerCase())) {
    throw new HttpsError("already-exists", "A team with this name already exists.");
  }
  const teamId = `team_${Date.now()}_${randomBytes(2).toString("hex")}`;
  await teamsRef.doc(teamId).set({ id: teamId, name, captain, players, createdAt: FieldValue.serverTimestamp() });
  return { teamId, tournamentId: id };
});

export const createLeagueFixtures = onCall(async (request) => {
  const { id, ref } = await adminTournament(request.data?.tournamentId, request.data?.adminToken);
  const teamsSnap = await ref.collection("teams").get();
  if (teamsSnap.size !== 4) throw new HttpsError("failed-precondition", "Add all four teams before generating fixtures.");
  const teams = teamsSnap.docs.map(d => ({ id: d.id, name: d.get("name") }));
  const pairs = [[0,1],[0,2],[0,3],[1,2],[1,3],[2,3]];
  const matches = ref.collection("matches");
  const existing = await matches.where("stage", "==", "league").get();
  if (!existing.empty) throw new HttpsError("already-exists", "League fixtures have already been created.");
  const batch = db.batch();
  pairs.forEach((pair, index) => {
    const matchRef = matches.doc(`league_${index + 1}`);
    batch.set(matchRef, {
      id: matchRef.id, stage: "league", round: "League",
      matchNumber: index + 1, teamA: teams[pair[0]], teamB: teams[pair[1]],
      sets: [], status: "upcoming", winnerId: null, createdAt: FieldValue.serverTimestamp()
    });
  });
  batch.update(ref, { status: "league" });
  await batch.commit();
  return { tournamentId: id, matchCount: 6 };
});

export const updateMatchScore = onCall(async (request) => {
  const { ref } = await adminTournament(request.data?.tournamentId, request.data?.adminToken);
  const matchId = clean(request.data?.matchId, 80);
  const rawSets = Array.isArray(request.data?.sets) ? request.data.sets : [];
  if (rawSets.length < 1 || rawSets.length > 3) throw new HttpsError("invalid-argument", "Enter one to three set scores.");
  const matchRef = ref.collection("matches").doc(matchId);
  const matchSnap = await matchRef.get();
  if (!matchSnap.exists) throw new HttpsError("not-found", "Match not found.");
  const match = matchSnap.data();
  const sets = rawSets.map(s => ({
    a: Math.max(0, Math.min(99, Number(s.a) || 0)),
    b: Math.max(0, Math.min(99, Number(s.b) || 0))
  }));
  let winsA = 0, winsB = 0;
  sets.forEach((s, i) => {
    if (s.a === s.b) throw new HttpsError("invalid-argument", `Set ${i + 1} cannot end in a tie.`);
    if (s.a > s.b) winsA++; else winsB++;
  });
  const finished = winsA === 2 || winsB === 2;
  if (finished && (winsA + winsB !== sets.length)) {
    throw new HttpsError("invalid-argument", "Remove scores entered after the winning set.");
  }
  if (!finished && sets.length === 3) {
    throw new HttpsError("invalid-argument", "A best-of-three match ends when a team wins two sets.");
  }
  const winner = finished ? (winsA > winsB ? match.teamA : match.teamB) : null;
  await matchRef.update({
    sets,
    status: finished ? "completed" : "live",
    winnerId: winner?.id ?? null,
    winnerName: winner?.name ?? null,
    updatedAt: FieldValue.serverTimestamp()
  });
  return { status: finished ? "completed" : "live", winner: winner?.name ?? null };
});

export const createKnockoutFixtures = onCall(async (request) => {
  const { id, ref } = await adminTournament(request.data?.tournamentId, request.data?.adminToken);
  const leagueSnap = await ref.collection("matches").where("stage", "==", "league").get();
  if (leagueSnap.size !== 6 || leagueSnap.docs.some(d => d.get("status") !== "completed")) {
    throw new HttpsError("failed-precondition", "Complete all six league matches before creating the knockout stage.");
  }
  const existing = await ref.collection("matches").where("stage", "==", "knockout").get();
  if (!existing.empty) throw new HttpsError("already-exists", "Knockout fixtures already exist.");
  const teamDocs = await ref.collection("teams").get();
  const teams = teamDocs.docs.map(d => ({ id: d.id, name: d.get("name") }));
  const stats = Object.fromEntries(teams.map(t => [t.id, { ...t, played:0, wins:0, losses:0, setsFor:0, setsAgainst:0, points:0 }]));
  leagueSnap.docs.forEach(doc => {
    const m = doc.data();
    const a = stats[m.teamA.id], b = stats[m.teamB.id];
    a.played++; b.played++;
    let wa=0, wb=0;
    (m.sets || []).forEach(s => { a.setsFor += s.a; a.setsAgainst += s.b; b.setsFor += s.b; b.setsAgainst += s.a; if(s.a>s.b) wa++; else wb++; });
    if (wa > wb) { a.wins++; b.losses++; a.points += (wa === 2 && wb === 1) ? 2 : 3; b.points += (wa === 2 && wb === 1) ? 1 : 0; }
    else { b.wins++; a.losses++; b.points += (wb === 2 && wa === 1) ? 2 : 3; a.points += (wb === 2 && wa === 1) ? 1 : 0; }
  });
  const ranked = Object.values(stats).sort((a,b) => b.points-a.points || (b.setsFor-b.setsAgainst)-(a.setsFor-a.setsAgainst));
  const batch = db.batch();
  const matches = ref.collection("matches");
  batch.set(matches.doc("semi_1"), { id:"semi_1", stage:"knockout", round:"Semi-final 1", matchNumber:7, teamA:ranked[0], teamB:ranked[3], sets:[], status:"upcoming", winnerId:null });
  batch.set(matches.doc("semi_2"), { id:"semi_2", stage:"knockout", round:"Semi-final 2", matchNumber:8, teamA:ranked[1], teamB:ranked[2], sets:[], status:"upcoming", winnerId:null });
  batch.update(ref, { status:"knockout" });
  await batch.commit();
  return { tournamentId:id, semifinals:[ranked[0].name,ranked[3].name,ranked[1].name,ranked[2].name] };
});

export const createFinal = onCall(async (request) => {
  const { ref } = await adminTournament(request.data?.tournamentId, request.data?.adminToken);
  const matches = ref.collection("matches");
  const semis = await matches.where("stage","==","knockout").get();
  if (semis.size !== 2 || semis.docs.some(d => d.get("status") !== "completed")) {
    throw new HttpsError("failed-precondition","Complete both semi-finals first.");
  }
  if ((await matches.doc("final").get()).exists) throw new HttpsError("already-exists","Final already exists.");
  const winners = semis.docs.map(d => ({ id:d.get("winnerId"), name:d.get("winnerName") }));
  await matches.doc("final").set({ id:"final", stage:"knockout", round:"Final", matchNumber:9, teamA:winners[0], teamB:winners[1], sets:[], status:"upcoming", winnerId:null });
  await ref.update({ status:"final" });
  return { ok:true };
});

export const setTournamentWinner = onCall(async (request) => {
  const { ref } = await adminTournament(request.data?.tournamentId, request.data?.adminToken);
  const finalSnap = await ref.collection("matches").doc("final").get();
  if (!finalSnap.exists || finalSnap.get("status") !== "completed") throw new HttpsError("failed-precondition","Complete the final match first.");
  await ref.update({ status:"completed", winnerId:finalSnap.get("winnerId"), winnerName:finalSnap.get("winnerName") });
  return { winner:finalSnap.get("winnerName") };
});
