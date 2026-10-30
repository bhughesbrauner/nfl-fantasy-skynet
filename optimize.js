require("dotenv").config();
const axios = require("axios");

// Usage:
//   node optimize.js              prints the optimized lineup and the moves, sends nothing
//   node optimize.js --write      also sends the moves to ESPN, then re-reads the roster to check them
//   node optimize.js --period=5   optimizes for scoring period 5 instead of ESPN's current period
//   node optimize.js --auto       for the scheduled workflow: exits unless a game kicks off within the
//                                 next 75 minutes, then writes (same as --write)
//
// Players whose NFL team has a game in progress or finished are locked. They stay in their current
// slot and the rest of the lineup is optimized around them.

const AUTO = process.argv.includes("--auto");
const WRITE = AUTO || process.argv.includes("--write");
const periodArg = process.argv.find((a) => a.startsWith("--period="));
const PERIOD_OVERRIDE = periodArg ? Number(periodArg.split("=")[1]) : undefined;

const LEAGUE_ID = process.env.LEAGUE_ID;
const ESPN_S2 = process.env.ESPN_S2;
const SWID = process.env.SWID;
const TEAM_ID = process.env.TEAM_ID;

// ESPN names a season by the year it starts in. The season starts in August (preseason), so
// January through July still belong to the prior year's season.
const now0 = new Date();
const SEASON_ID = now0.getMonth() >= 7 ? now0.getFullYear() : now0.getFullYear() - 1;

// Views go in the URL string. Axios would send an array in `params` as view[]=..., which ESPN ignores.
// mSettings gives the league's lineup slot counts, so the starter list comes from the league itself.
const READS_URL = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${SEASON_ID}/segments/0/leagues/${LEAGUE_ID}?view=mRoster&view=mTeam&view=mStatus&view=mSettings`;
// Unverified: the host comes from espn-fantasy-mcp's writes.ts. The HTTP method and
// path are assumed to be POST to .../transactions/. Confirm against client.ts before using --write.
const WRITES_URL = `https://lm-api-writes.fantasy.espn.com/apis/v3/games/ffl/seasons/${SEASON_ID}/segments/0/leagues/${LEAGUE_ID}/transactions/`;

// Public ESPN scoreboard for the current NFL week. No auth.
const SCOREBOARD_URL = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard";
// The planner schedules runs 60 minutes before kickoff (rounded down to 5 minutes), so the window
// is wider than 60 to cover that rounding and any delay in GitHub starting the run.
const WINDOW_MINUTES = 75;

const COOKIE = `SWID=${SWID}; espn_s2=${ESPN_S2}`;

// ESPN football lineup slot IDs (from ffscrapr's espn_lineupslot_map).
const BENCH = 20;
const IR = 21;
const SLOT_NAME = {
  0: "QB", 1: "TQB", 2: "RB", 3: "RB/WR", 4: "WR", 5: "WR/TE", 6: "TE", 7: "OP",
  8: "DT", 9: "DE", 10: "LB", 11: "DL", 12: "CB", 13: "S", 14: "DB", 15: "DP",
  16: "D/ST", 17: "K", 18: "P", 19: "HC", 20: "BE", 21: "IR", 22: "XYZ",
  23: "RB/WR/TE", 24: "ER", 25: "Rookie",
};
const slotName = (id) => SLOT_NAME[id] ?? `slot ${id}`;

// Projected points for one scoring period (statSourceId 1 = projection).
// Season totals (scoringPeriodId 0) are never used.
function getProjectedPoints(player, scoringPeriod) {
  if (!Array.isArray(player.stats)) return 0;
  const projection = player.stats.find(
    (s) => s.scoringPeriodId === scoringPeriod && s.statSourceId === 1,
  );
  return projection?.appliedTotal || 0;
}

function headers(extra = {}) {
  return { Cookie: COOKIE, ...extra };
}

async function fetchTeam(period) {
  const { data } = await axios.get(READS_URL, {
    headers: headers(),
    params: { scoringPeriodId: period },
  });

  if (!Array.isArray(data.teams) || data.teams.length === 0) {
    throw new Error("No team data in response. Check LEAGUE_ID.");
  }
  const team = data.teams.find((t) => String(t.id) === String(TEAM_ID));
  if (!team) throw new Error(`Team ${TEAM_ID} not found. Check TEAM_ID in .env`);
  if (!team.roster?.entries) throw new Error("No roster entries found on team.");

  const players = team.roster.entries
    .map((entry) => {
      const player = entry.playerPoolEntry?.player;
      if (!player) return null;
      return {
        id: player.id,
        name: player.fullName,
        proTeamId: player.proTeamId,
        eligibleSlots: player.eligibleSlots || [],
        currentSlot: entry.lineupSlotId,
        projectedPoints: getProjectedPoints(player, period),
      };
    })
    .filter(Boolean);

  return {
    name: team.name,
    players,
    lineupSlotCounts: data.settings?.rosterSettings?.lineupSlotCounts ?? {},
    latestPeriod: data.status?.latestScoringPeriod,
  };
}

async function fetchScoreboard() {
  const { data } = await axios.get(SCOREBOARD_URL);
  return data.events || [];
}

// True when a game has not kicked off yet and starts within WINDOW_MINUTES.
function kickoffInWindow(events) {
  const now = Date.now();
  const soon = events.filter((e) => {
    if (e.status?.type?.state !== "pre") return false;
    const minutes = (Date.parse(e.date) - now) / 60000;
    return minutes > 0 && minutes <= WINDOW_MINUTES;
  });
  soon.forEach((e) => {
    const minutes = Math.round((Date.parse(e.date) - now) / 60000);
    console.log(`Kickoff in ${minutes} min: ${e.shortName} (${e.date})`);
  });
  return soon.length > 0;
}

// NFL team IDs whose game has started (in progress or final). Their players are locked.
function lockedTeamIds(events) {
  const ids = new Set();
  for (const e of events) {
    const state = e.status?.type?.state;
    if (state !== "in" && state !== "post") continue;
    for (const c of e.competitions?.[0]?.competitors || []) {
      ids.add(String(c.team?.id));
    }
  }
  return ids;
}

// One entry per starting slot the league uses, e.g. [0, 2, 2, 3, 4, 23, 16, 17].
function startingSlots(lineupSlotCounts) {
  const slots = [];
  for (const [id, count] of Object.entries(lineupSlotCounts)) {
    const slot = Number(id);
    if (slot === BENCH || slot === IR || count <= 0) continue;
    for (let i = 0; i < count; i++) slots.push(slot);
  }
  return slots;
}

// Greedy: fill the most restricted slots first, each with the highest-projected unused eligible player.
// Restricted first means a flex-eligible player is not used up before a QB or K slot needs him.
// Only the players passed in are considered, so the caller decides who can move.
function buildLineup(movable, slots) {
  const candidatesFor = (slot) => movable.filter((p) => p.eligibleSlots.includes(slot));
  const ordered = [...slots].sort((a, b) => candidatesFor(a).length - candidatesFor(b).length);

  const used = new Set();
  const assignments = new Map(); // playerId -> slot ID
  for (const slot of ordered) {
    const best = candidatesFor(slot)
      .filter((p) => !used.has(p.id))
      .sort((a, b) => b.projectedPoints - a.projectedPoints)[0];
    if (best) {
      assignments.set(best.id, slot);
      used.add(best.id);
    }
  }
  return assignments;
}

// Compare the optimal assignments with the roster's current slots and build the moves.
// IR players and locked players are never moved. Every other player goes to a starter slot or the bench.
function buildMoves(players, assignments, frozenIds) {
  const moves = [];
  for (const p of players) {
    if (p.currentSlot === IR || frozenIds.has(p.id)) continue;
    const target = assignments.get(p.id) ?? BENCH;
    if (p.currentSlot !== target) {
      moves.push({ playerId: p.id, name: p.name, fromSlot: p.currentSlot, toSlot: target });
    }
  }
  return moves;
}

// Every starter a player is moved into must be one they are eligible for.
function validateMoves(players, moves) {
  const byId = new Map(players.map((p) => [p.id, p]));
  const problems = [];
  for (const m of moves) {
    const p = byId.get(m.playerId);
    if (m.toSlot !== BENCH && !p.eligibleSlots.includes(m.toSlot)) {
      problems.push(`${p.name} is not eligible for ${slotName(m.toSlot)}`);
    }
  }
  return problems;
}

// Players in a slot the league does not use (other than bench and IR) stop the run.
// Moving them would be a real lineup change the script does not understand.
function unknownSlotPlayers(players, lineupSlotCounts) {
  return players.filter(
    (p) => p.currentSlot !== BENCH && p.currentSlot !== IR && !(lineupSlotCounts[p.currentSlot] > 0),
  );
}

// Same body shape as espn-fantasy-mcp's buildLineupBody: one LINEUP item per moved player,
// each carrying its own current slot as fromLineupSlotId.
function buildLineupBody(moves, period) {
  return {
    isLeagueManager: false,
    teamId: Number(TEAM_ID),
    type: "ROSTER",
    memberId: SWID,
    scoringPeriodId: period,
    executionType: "EXECUTE",
    items: moves.map((m) => ({
      playerId: m.playerId,
      type: "LINEUP",
      fromLineupSlotId: m.fromSlot ?? -1,
      toLineupSlotId: m.toSlot,
    })),
  };
}

function printLineup(players, assignments) {
  console.log("\n=== OPTIMIZED LINEUP ===");
  let total = 0;
  const rows = players
    .filter((p) => assignments.has(p.id))
    .sort((a, b) => assignments.get(a.id) - assignments.get(b.id));
  for (const p of rows) {
    total += p.projectedPoints;
    console.log(`${slotName(assignments.get(p.id)).padEnd(10)} ${p.name.padEnd(25)} ${p.projectedPoints.toFixed(1)} pts`);
  }
  console.log(`\nTotal projected: ${total.toFixed(1)} pts`);
}

async function sendMoves(moves, period) {
  const body = buildLineupBody(moves, period);
  console.log("\nSending lineup change to ESPN...");
  const response = await axios.post(WRITES_URL, body, {
    headers: headers({ "Content-Type": "application/json" }),
  });
  console.log(`ESPN responded with status ${response.status}.`);
}

// Returns true when every move is on the roster read-back.
async function verify(moves, period) {
  // ESPN's reads can lag writes, so re-read a few times before reporting a mismatch.
  const delays = [3000, 8000, 15000];
  let mismatches = [];
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, delays[attempt - 1]));
    const team = await fetchTeam(period);
    const bySlot = new Map(team.players.map((p) => [p.id, p.currentSlot]));
    mismatches = moves
      .filter((m) => bySlot.get(m.playerId) !== m.toSlot)
      .map((m) => `${m.name}: expected ${slotName(m.toSlot)}, roster shows ${slotName(bySlot.get(m.playerId))}`);
    if (mismatches.length === 0) break;
  }
  if (mismatches.length === 0) {
    console.log("Verified: every move is on the roster read-back.");
    return true;
  }
  console.error("Mismatches after re-reading:");
  mismatches.forEach((m) => console.error(`  ${m}`));
  return false;
}

async function main() {
  if (!LEAGUE_ID || !TEAM_ID || !SWID || !ESPN_S2) {
    throw new Error("Missing LEAGUE_ID, TEAM_ID, SWID or ESPN_S2 in .env");
  }

  // The scoreboard decides both the trigger window and which players are locked.
  // If it can't be read, the run stops rather than guess at locks.
  const events = await fetchScoreboard();

  if (AUTO && !kickoffInWindow(events)) {
    console.log(`No kickoff in the next ${WINDOW_MINUTES} minutes. Nothing to do.`);
    return;
  }

  // First read gives ESPN's current period, unless --period was passed.
  const probe = await fetchTeam(undefined);
  const period = PERIOD_OVERRIDE ?? probe.latestPeriod;
  if (period === undefined || period === null) {
    throw new Error("ESPN returned no status.latestScoringPeriod. Pass --period=N to choose one.");
  }
  if (PERIOD_OVERRIDE !== undefined && PERIOD_OVERRIDE < (probe.latestPeriod ?? 0)) {
    throw new Error(`Period ${PERIOD_OVERRIDE} is before ESPN's current period ${probe.latestPeriod}; that period is locked.`);
  }

  // Re-read for the chosen period. The first read had no scoringPeriodId, so its projections are not for this week.
  const team = await fetchTeam(period);

  const unknown = unknownSlotPlayers(team.players, team.lineupSlotCounts);
  if (unknown.length > 0) {
    console.error("\nNothing sent. These players are in lineup slots the league does not use:");
    unknown.forEach((p) => console.error(`  ${p.name}: ${slotName(p.currentSlot)}`));
    process.exit(1);
  }

  console.log(`Team: ${team.name}`);
  console.log(`Season: ${SEASON_ID}, scoring period: ${period}`);
  console.log(
    "League starting slots: " +
      Object.entries(team.lineupSlotCounts)
        .filter(([id, c]) => Number(id) !== BENCH && Number(id) !== IR && c > 0)
        .map(([id, c]) => `${slotName(Number(id))} x${c}`)
        .join(", "),
  );

  // Locked players stay where they are. Their starter slots come off the top, and the rest is optimized around them.
  const lockedTeams = lockedTeamIds(events);
  const frozen = team.players.filter((p) => lockedTeams.has(String(p.proTeamId)));
  const frozenIds = new Set(frozen.map((p) => p.id));
  if (frozen.length > 0) {
    console.log("\nLocked (game started or finished), left in place:");
    frozen.forEach((p) => console.log(`  ${p.name.padEnd(25)} ${slotName(p.currentSlot)} (proTeamId ${p.proTeamId})`));
  }

  const movable = team.players.filter((p) => !frozenIds.has(p.id) && p.currentSlot !== IR);
  const openSlots = startingSlots(team.lineupSlotCounts);
  for (const p of frozen) {
    const i = openSlots.indexOf(p.currentSlot);
    if (i >= 0) openSlots.splice(i, 1);
  }

  const assignments = buildLineup(movable, openSlots);
  for (const p of frozen) {
    if (p.currentSlot !== BENCH && p.currentSlot !== IR) assignments.set(p.id, p.currentSlot);
  }
  printLineup(team.players.filter((p) => p.currentSlot !== IR), assignments);

  const moves = buildMoves(team.players, assignments, frozenIds);
  const problems = validateMoves(team.players, moves);
  if (problems.length > 0) {
    console.error("\nNothing sent. Problems:");
    problems.forEach((p) => console.error(`  ${p}`));
    process.exit(1);
  }

  console.log(`\nMoves needed: ${moves.length}`);
  moves.forEach((m) => console.log(`  ${m.name.padEnd(25)} ${slotName(m.fromSlot)} -> ${slotName(m.toSlot)}`));

  if (moves.length === 0) {
    console.log("\nLineup already matches the optimum. Nothing to send.");
    return;
  }

  if (!WRITE) {
    console.log("\nDry run. Nothing sent. Add --write to set this lineup in ESPN.");
    console.log("\nRequest body that would be sent:");
    console.log(JSON.stringify(buildLineupBody(moves, period), null, 2));
    return;
  }

  await sendMoves(moves, period);
  const ok = await verify(moves, period);
  if (!ok) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error("Error:", error.message);
    if (error.response?.status === 401) console.error("Auth failed. Check ESPN_S2 and SWID in .env");
    if (error.response?.status === 404) console.error("League not found. Check LEAGUE_ID in .env");
    if (error.response?.data) console.error("ESPN said:", JSON.stringify(error.response.data));
    process.exit(1);
  });
}

module.exports = { startingSlots, buildLineup, buildMoves, lockedTeamIds, kickoffInWindow, IR, BENCH };
