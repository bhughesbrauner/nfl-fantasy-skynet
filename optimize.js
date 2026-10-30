require("dotenv").config();
const axios = require("axios");

const LEAGUE_ID = process.env.LEAGUE_ID;
const ESPN_S2 = process.env.ESPN_S2;
const SWID = process.env.SWID;
const TEAM_ID = process.env.TEAM_ID;
const SEASON_ID = new Date().getFullYear();
const SCORING_PERIOD = getScorePeriod();

function getScorePeriod() {
  const now = new Date();
  const sept1 = new Date(now.getFullYear(), 8, 1);
  const diff = now - sept1;
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  const week = Math.ceil(days / 7) + 1;
//   return Math.max(1, Math.min(week, 18));
  return 1; // TODO: Fix this 
}

const LINEUP_SLOTS = {
  QB: { count: 1, positions: ["QB"] },
  RB: { count: 2, positions: ["RB"] },
  WR: { count: 2, positions: ["WR"] },
  TE: { count: 1, positions: ["TE"] },
  FLEX: { count: 1, positions: ["RB", "WR", "TE"] },
  K: { count: 1, positions: ["K"] },
  DEF: { count: 1, positions: ["D/ST"] },
};

// Map ESPN lineup slot IDs to position strings
const positionIdMap = {
  0: "QB",
  2: "RB",
  4: "WR",
  6: "TE",
  16: "D/ST",
  17: "K",
};

// A player's position is the first of their eligible slots that is in positionIdMap.
// FLEX (23), Bench (20) and IR (21) are not in the map, so they are skipped.
function getPosition(player) {
  const slot = (player.eligibleSlots || []).find((id) => id in positionIdMap);
  return slot === undefined ? "Bench" : positionIdMap[slot];
}

// Projected points for one scoring period (statSourceId: 1 = projection).
// Returns 0 when the week has no projection. Season totals are not used here.
function getProjectedPoints(player, scoringPeriod) {
  if (!player.stats || !Array.isArray(player.stats)) return 0;

  const projection = player.stats.find(
    (s) => s.scoringPeriodId === scoringPeriod && s.statSourceId === 1,
  );

  return projection?.appliedTotal || 0;
}

async function optimize() {
  try {
    const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${SEASON_ID}/segments/0/leagues/${LEAGUE_ID}?view=mRoster&view=mTeam`;

    console.log(`Fetching team roster for week ${SCORING_PERIOD}...`);
    const response = await axios.get(url, {
      headers: {
        Cookie: `SWID=${SWID}; espn_s2=${ESPN_S2}`,
      },
      params: {
        scoringPeriodId: SCORING_PERIOD,
      },
    });

    const data = response.data;

    // mRoster returns teams array. Find first team (yours)
    if (!data.teams || !Array.isArray(data.teams) || data.teams.length === 0) {
      throw new Error("No team data in response. Check league ID.");
    }

    const myTeam = data.teams.find((t) => t.id.toString() === TEAM_ID);
    if (!myTeam) {
      throw new Error(`Team ${TEAM_ID} not found. Check TEAM_ID in .env`);
    }
    console.log(`Found team: ${myTeam.name}`);

    // Extract roster entries (each is a player slot with assigned player)
    if (!myTeam.roster || !myTeam.roster.entries) {
      throw new Error("No roster entries found on team.");
    }

    // Build players list from roster entries
    const allPlayers = myTeam.roster.entries
      .map((entry) => {
        // mRoster nests player info under playerPoolEntry
        const player = entry.playerPoolEntry?.player;
        if (!player) return null;

        const projected = getProjectedPoints(player, SCORING_PERIOD);

        return {
          id: player.id,
          name: player.fullName,
          position: getPosition(player),
          nflTeam: player.proTeamId || 0,
          projectedPoints: projected,
        };
      })
      .filter((p) => p !== null);

    console.log(`Roster: ${allPlayers.length} players`);

    // Build lineup greedily: for each slot, pick highest-projected available player
    const lineup = [];
    const slotsNeeded = [];
    Object.entries(LINEUP_SLOTS).forEach(([name, config]) => {
      for (let i = 0; i < config.count; i++) {
        slotsNeeded.push({ name, positions: config.positions });
      }
    });

    const used = new Set();

    for (const slot of slotsNeeded) {
      const candidate = allPlayers
        .filter((p) => !used.has(p.id) && slot.positions.includes(p.position))
        .sort((a, b) => b.projectedPoints - a.projectedPoints)[0];

      if (candidate) {
        lineup.push({ slot: slot.name, ...candidate });
        used.add(candidate.id);
      }
    }

    // Print results
    console.log("\n=== OPTIMIZED LINEUP ===");
    let totalProjected = 0;
    lineup.forEach((entry) => {
      console.log(
        `${entry.slot.padEnd(6)} ${entry.name.padEnd(25)} ${entry.position.padEnd(4)} ${entry?.nflTeam?.toString().padEnd(3)} ${entry.projectedPoints.toFixed(1)} pts`,
      );
      totalProjected += entry.projectedPoints;
    });
    console.log(`\nTotal projected: ${totalProjected.toFixed(1)} pts`);

    return lineup;
  } catch (error) {
    console.error("Error:", error.message);
    if (error.response?.status === 401) {
      console.error("Auth failed. Check ESPN_S2 and SWID in .env");
    }
    if (error.response?.status === 404) {
      console.error("League not found. Check LEAGUE_ID in .env");
    }
    process.exit(1);
  }
}

optimize();
