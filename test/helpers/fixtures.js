// Builders for ESPN-shaped test data. Field names match the real API responses the script reads.

const TEAM_ID = 10;
const PERIOD = 8;

// One roster entry: a player in a lineup slot, with a projection for PERIOD.
function entry({ id, name, proTeamId = 1, eligible, slot, proj = 0 }) {
  return {
    lineupSlotId: slot,
    playerPoolEntry: {
      player: {
        id,
        fullName: name,
        proTeamId,
        eligibleSlots: eligible,
        stats: [{ scoringPeriodId: PERIOD, statSourceId: 1, appliedTotal: proj }],
      },
    },
  };
}

// The standard test roster. Slots: QB 0, RB 2, WR 4, TE 6, FLEX 23, K 17, D/ST 16, bench 20, IR 21.
// Team ids: 1 is an NFL team with a game (locked in some tests), 3 has an IR player.
function standardEntries() {
  return [
    entry({ id: 1, name: "Burrow", proTeamId: 4, eligible: [0], slot: 0, proj: 17.3 }),
    entry({ id: 2, name: "Bijan", proTeamId: 1, eligible: [2, 23], slot: 2, proj: 17.4 }),
    entry({ id: 3, name: "Love", proTeamId: 22, eligible: [2, 23], slot: 20, proj: 13 }),
    entry({ id: 4, name: "London", proTeamId: 1, eligible: [4, 3, 23], slot: 4, proj: 13.4 }),
    entry({ id: 5, name: "Smith", proTeamId: 21, eligible: [4, 3, 23], slot: 4, proj: 14 }),
    entry({ id: 6, name: "Pitts", proTeamId: 1, eligible: [6, 5, 23], slot: 6, proj: 9.2 }),
    entry({ id: 7, name: "Dicker", proTeamId: 24, eligible: [17], slot: 17, proj: 10 }),
    entry({ id: 8, name: "Ravens", proTeamId: 33, eligible: [16], slot: 16, proj: 7.7 }),
    entry({ id: 9, name: "IR Star", proTeamId: 3, eligible: [2, 23], slot: 21, proj: 30 }),
    entry({ id: 10, name: "WR Bench", proTeamId: 2, eligible: [4, 3, 23], slot: 20, proj: 6 }),
    entry({ id: 11, name: "RB Bench", proTeamId: 5, eligible: [2, 23], slot: 20, proj: 4 }),
  ];
}

const STANDARD_COUNTS = { 0: 1, 2: 2, 4: 2, 6: 1, 23: 1, 17: 1, 16: 1, 20: 7, 21: 1 };

// The mRoster/mSettings response for the test team.
function rosterResponse({ entries = standardEntries(), counts = STANDARD_COUNTS, latest = PERIOD, teamId = TEAM_ID } = {}) {
  return {
    status: { latestScoringPeriod: latest },
    settings: { rosterSettings: { lineupSlotCounts: counts } },
    teams: [{ id: teamId, name: "Skynet 2: Judgement Day", roster: { entries } }],
  };
}

// A scoreboard event. state is "pre", "in" or "post". minutes is minutes from now to kickoff.
function event({ state = "pre", minutes = 120, teams = [1, 2], shortName = "AAA @ BBB" } = {}) {
  return {
    id: `${shortName}-${minutes}`,
    date: new Date(Date.now() + minutes * 60000).toISOString(),
    shortName,
    status: { type: { state } },
    competitions: [{ competitors: teams.map((id) => ({ team: { id: String(id) } })) }],
  };
}

module.exports = { TEAM_ID, PERIOD, entry, standardEntries, STANDARD_COUNTS, rosterResponse, event };
