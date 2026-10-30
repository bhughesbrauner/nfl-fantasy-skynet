require("dotenv").config();
const axios = require("axios");

// Usage:
//   node optimize.js              prints the optimized lineup and the moves, sends nothing
//   node optimize.js --write      also sends the moves to ESPN, then re-reads the roster to check them
//   node optimize.js --period=5   optimizes for scoring period 5 instead of ESPN's current period

const WRITE = process.argv.includes("--write");
const periodArg = process.argv.find((a) => a.startsWith("--period="));
const PERIOD_OVERRIDE = periodArg ? Number(periodArg.split("=")[1]) : undefined;

const LEAGUE_ID = process.env.LEAGUE_ID;
const ESPN_S2 = process.env.ESPN_S2;
const SWID = process.env.SWID;
const TEAM_ID = process.env.TEAM_ID;
const SEASON_ID = new Date().getFullYear();

const READS_URL = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${SEASON_ID}/segments/0/leagues/${LEAGUE_ID}`;
// Unverified: the host comes from espn-fantasy-mcp's writes.ts. The HTTP method and
// path are assumed to be POST to .../transactions/. Confirm against client.ts before using --write.
const WRITES_URL = `https://lm-api-writes.fantasy.espn.com/apis/v3/games/ffl/seasons/${SEASON_ID}/segments/0/leagues/${LEAGUE_ID}/transactions/`;

const COOKIE = `SWID=${SWID}; espn_s2=${ESPN_S2}`;

// ESPN lineup slot IDs (football)
const SLOT = { QB: 0, RB: 2, WR: 4, TE: 6, DEF: 16, K: 17, BENCH: 20, IR: 21, FLEX: 23 };
const SLOT_NAME = Object.fromEntries(Object.entries(SLOT).map(([name, id]) => [id, name]));

// Starting slots in fill order. Each entry lists the slot ID and the eligible positions.
// Positions come from the player's eligibleSlots, so FLEX (23) is filled from RB/WR/TE.
const STARTING_SLOTS = [
  { slot: SLOT.QB, label: "QB", positions: ["QB"] },
  { slot: SLOT.RB, label: "RB", positions: ["RB"] },
  { slot: SLOT.RB, label: "RB", positions: ["RB"] },
  { slot: SLOT.WR, label: "WR", positions: ["WR"] },
  { slot: SLOT.WR, label: "WR", positions: ["WR"] },
  { slot: SLOT.TE, label: "TE", positions: ["TE"] },
  { slot: SLOT.FLEX, label: "FLEX", positions: ["RB", "WR", "TE"] },
  { slot: SLOT.K, label: "K", positions: ["K"] },
  { slot: SLOT.DEF, label: "DEF", positions: ["D/ST"] },
];

// Position from the player's eligibleSlots (the starting slots they can fill).
const POSITION_BY_SLOT = {
  [SLOT.QB]: "QB",
  [SLOT.RB]: "RB",
  [SLOT.WR]: "WR",
  [SLOT.TE]: "TE",
  [SLOT.DEF]: "D/ST",
  [SLOT.K]: "K",
};

function getPosition(player) {
  const slot = (player.eligibleSlots || []).find((id) => id in POSITION_BY_SLOT);
  return slot === undefined ? "Bench" : POSITION_BY_SLOT[slot];
}

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
    params: { view: ["mRoster", "mTeam", "mStatus"], scoringPeriodId: period },
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
        position: getPosition(player),
        eligibleSlots: player.eligibleSlots || [],
        currentSlot: entry.lineupSlotId,
        projectedPoints: getProjectedPoints(player, period),
      };
    })
    .filter(Boolean);

  return { name: team.name, players, latestPeriod: data.status?.latestScoringPeriod };
}

// Greedy: fill each starting slot with the highest-projected unused eligible player.
// Bench and IR players are not eligible for starting slots here, so they go to the bench.
function buildLineup(players) {
  const used = new Set();
  const assignments = new Map(); // playerId -> slot ID

  for (const { slot, label, positions } of STARTING_SLOTS) {
    const candidate = players
      .filter((p) => !used.has(p.id) && positions.includes(p.position))
      .sort((a, b) => b.projectedPoints - a.projectedPoints)[0];
    if (candidate) {
      assignments.set(candidate.id, slot);
      used.add(candidate.id);
    }
  }
  return assignments;
}

// Compare the optimal assignments with the roster's current slots and build the moves.
// IR players stay where they are. Every other player goes to a starting slot or the bench.
function buildMoves(players, assignments) {
  const moves = [];
  for (const p of players) {
    if (p.currentSlot === SLOT.IR) continue;
    const target = assignments.get(p.id) ?? SLOT.BENCH;
    if (p.currentSlot !== target) {
      moves.push({ playerId: p.id, name: p.name, fromSlot: p.currentSlot, toSlot: target });
    }
  }
  return moves;
}

// Check that every starting slot a player is moved into is one they are eligible for.
function validateMoves(players, moves) {
  const byId = new Map(players.map((p) => [p.id, p]));
  const problems = [];
  for (const m of moves) {
    const p = byId.get(m.playerId);
    if (m.toSlot !== SLOT.BENCH && !p.eligibleSlots.includes(m.toSlot)) {
      problems.push(`${p.name} is not eligible for ${SLOT_NAME[m.toSlot]}`);
    }
  }
  return problems;
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
    .sort((a, b) => STARTING_SLOTS.findIndex((s) => s.slot === assignments.get(a.id)) - STARTING_SLOTS.findIndex((s) => s.slot === assignments.get(b.id)));
  for (const p of rows) {
    total += p.projectedPoints;
    console.log(
      `${(SLOT_NAME[assignments.get(p.id)] || "").padEnd(6)} ${p.name.padEnd(25)} ${p.position.padEnd(5)} ${p.projectedPoints.toFixed(1)} pts`,
    );
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
  return body;
}

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
      .map((m) => `${m.name}: expected ${SLOT_NAME[m.toSlot]}, roster shows ${SLOT_NAME[bySlot.get(m.playerId)] ?? bySlot.get(m.playerId)}`);
    if (mismatches.length === 0) break;
  }
  if (mismatches.length === 0) {
    console.log("Verified: every move is on the roster read-back.");
  } else {
    console.log("Mismatches after re-reading:");
    mismatches.forEach((m) => console.log(`  ${m}`));
  }
}

async function main() {
  if (!LEAGUE_ID || !TEAM_ID || !SWID || !ESPN_S2) {
    throw new Error("Missing LEAGUE_ID, TEAM_ID, SWID or ESPN_S2 in .env");
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

  const team = PERIOD_OVERRIDE !== undefined ? await fetchTeam(period) : probe;
  console.log(`Team: ${team.name}`);
  console.log(`Scoring period: ${period}`);

  const assignments = buildLineup(team.players);
  printLineup(team.players, assignments);

  const moves = buildMoves(team.players, assignments);
  const problems = validateMoves(team.players, moves);
  if (problems.length > 0) {
    console.error("\nNothing sent. Problems:");
    problems.forEach((p) => console.error(`  ${p}`));
    process.exit(1);
  }

  console.log(`\nMoves needed: ${moves.length}`);
  moves.forEach((m) =>
    console.log(`  ${m.name.padEnd(25)} ${SLOT_NAME[m.fromSlot] ?? m.fromSlot} -> ${SLOT_NAME[m.toSlot]}`),
  );

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
  await verify(moves, period);
}

main().catch((error) => {
  console.error("Error:", error.message);
  if (error.response?.status === 401) console.error("Auth failed. Check ESPN_S2 and SWID in .env");
  if (error.response?.status === 404) console.error("League not found. Check LEAGUE_ID in .env");
  process.exit(1);
});
