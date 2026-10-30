const { test, describe, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const { install } = require("./helpers/axios-stub");
const fx = require("./helpers/fixtures");

// Fixture object shared with the axios stub. Each test resets it.
const fixture = { events: [], rosters: [] };
const { calls } = install(fixture);

// optimize.js reads env at load time. Set it before requiring.
process.env.LEAGUE_ID = "1111242860";
process.env.TEAM_ID = String(fx.TEAM_ID);
process.env.SWID = "{TEST-SWID}";
process.env.ESPN_S2 = "test-espn-s2";
process.env.VERIFY_DELAYS_MS = "[0,0,0]";

const optimize = require(path.join(__dirname, "..", "optimize.js"));
const { BENCH, IR } = optimize;

const P = (id, name, eligibleSlots, currentSlot, projectedPoints, proTeamId = 1) => ({
  id,
  name,
  eligibleSlots,
  currentSlot,
  projectedPoints,
  proTeamId,
});

beforeEach(() => {
  fixture.events = [];
  fixture.rosters = [];
  fixture.scoreboardError = undefined;
  fixture.postError = undefined;
  fixture.readCount = 0;
  calls.length = 0;
});

describe("seasonFor", () => {
  test("January through July belong to the prior season", () => {
    assert.equal(optimize.seasonFor(new Date(2027, 0, 15)), 2026);
    assert.equal(optimize.seasonFor(new Date(2026, 6, 31)), 2025);
  });

  test("August onward is the season that starts that year", () => {
    assert.equal(optimize.seasonFor(new Date(2026, 7, 1)), 2026);
    assert.equal(optimize.seasonFor(new Date(2026, 11, 31)), 2026);
  });
});

describe("getProjectedPoints", () => {
  test("uses the projection for the requested period", () => {
    const player = {
      stats: [
        { scoringPeriodId: 8, statSourceId: 1, appliedTotal: 12.5 },
        { scoringPeriodId: 8, statSourceId: 0, appliedTotal: 99 },
      ],
    };
    assert.equal(optimize.getProjectedPoints(player, 8), 12.5);
  });

  test("ignores season totals (scoringPeriodId 0)", () => {
    const player = { stats: [{ scoringPeriodId: 0, statSourceId: 1, appliedTotal: 250 }] };
    assert.equal(optimize.getProjectedPoints(player, 8), 0);
  });

  test("returns 0 when there is no projection for the period", () => {
    const player = { stats: [{ scoringPeriodId: 7, statSourceId: 1, appliedTotal: 5 }] };
    assert.equal(optimize.getProjectedPoints(player, 8), 0);
  });

  test("returns 0 when stats are missing or not an array", () => {
    assert.equal(optimize.getProjectedPoints({}, 8), 0);
    assert.equal(optimize.getProjectedPoints({ stats: null }, 8), 0);
  });

  test("returns 0 when appliedTotal is null", () => {
    const player = { stats: [{ scoringPeriodId: 8, statSourceId: 1, appliedTotal: null }] };
    assert.equal(optimize.getProjectedPoints(player, 8), 0);
  });
});

describe("startingSlots", () => {
  test("expands counts into one entry per starter", () => {
    assert.deepEqual(optimize.startingSlots({ 0: 1, 2: 2, 23: 1 }).sort(), [0, 2, 2, 23]);
  });

  test("leaves out bench, IR and zero-count slots", () => {
    assert.deepEqual(optimize.startingSlots({ 0: 1, 20: 7, 21: 1, 17: 0 }), [0]);
  });

  test("returns an empty list for no counts", () => {
    assert.deepEqual(optimize.startingSlots({}), []);
  });
});

describe("buildLineup", () => {
  test("fills each slot with the highest projected eligible player", () => {
    const players = [
      P(1, "QB low", [0], 0, 10),
      P(2, "QB high", [0], 0, 20),
    ];
    const a = optimize.buildLineup(players, [0]);
    assert.equal(a.get(2), 0);
    assert.equal(a.has(1), false);
  });

  test("never puts one player in two slots", () => {
    const players = [P(1, "Flex only", [2, 23], 2, 30)];
    const a = optimize.buildLineup(players, [2, 2]);
    assert.equal(a.size, 1);
  });

  test("fills the restrictive slots first so FLEX does not take the only K", () => {
    // The only kicker is also flex-eligible. Filling FLEX first would waste him.
    const players = [
      P(1, "Kicker", [17, 23], 17, 8),
      P(2, "Runner", [2, 23], 2, 15),
    ];
    const a = optimize.buildLineup(players, [17, 23]);
    assert.equal(a.get(1), 17);
    assert.equal(a.get(2), 23);
  });

  test("a player with no eligible open slot stays unassigned", () => {
    const players = [P(1, "Tight end", [6], 6, 9), P(2, "Runner", [2], 2, 15)];
    const a = optimize.buildLineup(players, [2]);
    assert.equal(a.has(1), false);
    assert.equal(a.get(2), 2);
  });

  test("leaves slots empty when there are not enough players", () => {
    const a = optimize.buildLineup([P(1, "Solo", [0], 0, 5)], [0, 0]);
    assert.equal(a.size, 1);
  });

  test("returns an empty map with no movable players", () => {
    assert.equal(optimize.buildLineup([], [0, 2]).size, 0);
  });
});

describe("buildMoves", () => {
  test("no move when a player is already where the optimum puts him", () => {
    const players = [P(1, "QB", [0], 0, 10)];
    const a = new Map([[1, 0]]);
    assert.deepEqual(optimize.buildMoves(players, a, new Set()), []);
  });

  test("moves a bench player into a starter slot", () => {
    const players = [P(1, "Bench", [2, 23], BENCH, 15)];
    const a = new Map([[1, 2]]);
    assert.deepEqual(optimize.buildMoves(players, a, new Set()), [
      { playerId: 1, name: "Bench", fromSlot: BENCH, toSlot: 2 },
    ]);
  });

  test("benches a starter who is not in the optimum", () => {
    const players = [P(1, "Starter", [2], 2, 5)];
    const moves = optimize.buildMoves(players, new Map(), new Set());
    assert.equal(moves[0].toSlot, BENCH);
  });

  test("never moves IR players, even when the plan would start them", () => {
    const players = [P(1, "IR", [2], IR, 30)];
    const a = new Map([[1, 2]]);
    assert.deepEqual(optimize.buildMoves(players, a, new Set()), []);
  });

  test("never moves frozen (locked) players", () => {
    const players = [P(1, "Locked", [2], 2, 5), P(2, "Other", [2], 20, 15)];
    const a = new Map([[2, 2]]);
    const moves = optimize.buildMoves(players, a, new Set([1]));
    assert.deepEqual(moves.map((m) => m.playerId), [2]);
  });
});

describe("validateMoves", () => {
  test("accepts a move into an eligible slot", () => {
    const players = [P(1, "RB", [2, 23], 20, 10)];
    assert.deepEqual(optimize.validateMoves(players, [{ playerId: 1, toSlot: 23 }]), []);
  });

  test("flags a move into a slot the player cannot fill", () => {
    const players = [P(1, "RB", [2, 23], 20, 10)];
    const problems = optimize.validateMoves(players, [{ playerId: 1, toSlot: 17 }]);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /not eligible for K/);
  });

  test("moves to the bench are always allowed", () => {
    const players = [P(1, "Anyone", [0], 0, 10)];
    assert.deepEqual(optimize.validateMoves(players, [{ playerId: 1, toSlot: BENCH }]), []);
  });
});

describe("unknownSlotPlayers", () => {
  test("flags a player in a slot the league does not use", () => {
    const players = [P(1, "Wilson", [3], 3, 10)];
    assert.deepEqual(
      optimize.unknownSlotPlayers(players, { 0: 1, 2: 2 }).map((p) => p.id),
      [1],
    );
  });

  test("bench, IR and used slots are not flagged", () => {
    const players = [P(1, "A", [2], 2, 1), P(2, "B", [2], BENCH, 1), P(3, "C", [2], IR, 1)];
    assert.deepEqual(optimize.unknownSlotPlayers(players, { 2: 1 }), []);
  });
});

describe("buildLineupBody", () => {
  test("has the same shape as the ESPN lineup transaction", () => {
    const body = optimize.buildLineupBody(
      [{ playerId: 3, fromSlot: BENCH, toSlot: 2 }],
      8,
    );
    assert.deepEqual(body, {
      isLeagueManager: false,
      teamId: fx.TEAM_ID,
      type: "ROSTER",
      memberId: "{TEST-SWID}",
      scoringPeriodId: 8,
      executionType: "EXECUTE",
      items: [{ playerId: 3, type: "LINEUP", fromLineupSlotId: BENCH, toLineupSlotId: 2 }],
    });
  });

  test("uses -1 as fromLineupSlotId when the current slot is unknown", () => {
    const body = optimize.buildLineupBody([{ playerId: 3, fromSlot: undefined, toSlot: 2 }], 8);
    assert.equal(body.items[0].fromLineupSlotId, -1);
  });

  test("one item per move, in order", () => {
    const body = optimize.buildLineupBody(
      [
        { playerId: 1, fromSlot: 2, toSlot: BENCH },
        { playerId: 2, fromSlot: BENCH, toSlot: 2 },
      ],
      8,
    );
    assert.deepEqual(body.items.map((i) => i.playerId), [1, 2]);
  });
});

describe("lockedTeamIds", () => {
  test("in-progress and final games lock both teams", () => {
    const events = [
      { status: { type: { state: "in" } }, competitions: [{ competitors: [{ team: { id: "9" } }, { team: { id: "3" } }] }] },
      { status: { type: { state: "post" } }, competitions: [{ competitors: [{ team: { id: "5" } }, { team: { id: "6" } }] }] },
    ];
    assert.deepEqual([...optimize.lockedTeamIds(events)].sort(), ["3", "5", "6", "9"]);
  });

  test("scheduled games do not lock", () => {
    const events = [{ status: { type: { state: "pre" } }, competitions: [{ competitors: [{ team: { id: "1" } }] }] }];
    assert.equal(optimize.lockedTeamIds(events).size, 0);
  });

  test("events with missing fields are skipped, not thrown on", () => {
    assert.equal(optimize.lockedTeamIds([{}, { status: { type: { state: "in" } } }]).size, 0);
    assert.equal(optimize.lockedTeamIds([]).size, 0);
  });
});

describe("kickoffInWindow", () => {
  // A fixed clock, so the boundaries are exact rather than off by a few milliseconds.
  const NOW = Date.parse("2026-11-01T12:00:00Z");
  const W = optimize.WINDOW_MINUTES;
  const at = (ms) => new Date(NOW + ms).toISOString();
  const minutes = (m) => m * 60000;
  const ev = (state, ms) => ({ status: { type: { state } }, date: at(ms), shortName: "X @ Y" });
  const inWindow = (events) => optimize.kickoffInWindow(events, NOW);

  test("the window length is 75 minutes", () => {
    assert.equal(W, 75);
  });

  test("true for a scheduled game inside the window", () => {
    assert.equal(inWindow([ev("pre", minutes(30))]), true);
  });

  test("a game exactly WINDOW_MINUTES away is included", () => {
    assert.equal(inWindow([ev("pre", minutes(W))]), true);
  });

  test("a game one millisecond past the window edge is excluded", () => {
    assert.equal(inWindow([ev("pre", minutes(W) + 1)]), false);
  });

  test("a game one minute inside the window edge is included", () => {
    assert.equal(inWindow([ev("pre", minutes(W - 1))]), true);
  });

  test("a game at exactly kickoff (0 minutes away) is excluded", () => {
    assert.equal(inWindow([ev("pre", 0)]), false);
  });

  test("a game that already kicked off is excluded", () => {
    assert.equal(inWindow([ev("pre", minutes(-5))]), false);
  });

  test("an in-progress or final game does not count", () => {
    assert.equal(inWindow([ev("in", minutes(10)), ev("post", minutes(10))]), false);
  });

  test("one qualifying game is enough, even with others outside", () => {
    assert.equal(inWindow([ev("pre", minutes(W + 60)), ev("pre", minutes(20))]), true);
  });

  test("no events means no window", () => {
    assert.equal(inWindow([]), false);
  });

  test("uses the real clock when no time is passed", () => {
    const soon = [{ status: { type: { state: "pre" } }, date: new Date(Date.now() + minutes(20)).toISOString() }];
    assert.equal(optimize.kickoffInWindow(soon), true);
  });
});

describe("fetchScoreboard", () => {
  test("returns the events", async () => {
    fixture.events = [{ shortName: "A @ B" }];
    const events = await optimize.fetchScoreboard();
    assert.deepEqual(events, [{ shortName: "A @ B" }]);
  });

  test("returns an empty list when the response has no events", async () => {
    fixture.events = undefined;
    assert.deepEqual(await optimize.fetchScoreboard(), []);
  });

  test("propagates a failed request so the run stops", async () => {
    fixture.scoreboardError = "network down";
    await assert.rejects(optimize.fetchScoreboard(), /network down/);
  });
});

describe("fetchTeam", () => {
  test("maps roster entries to players with slot, eligibility and projection", async () => {
    fixture.rosters = [fx.rosterResponse()];
    const team = await optimize.fetchTeam(8);
    assert.equal(team.name, "Skynet 2: Judgement Day");
    assert.equal(team.latestPeriod, 8);
    assert.equal(team.lineupSlotCounts[2], 2);
    const bijan = team.players.find((p) => p.name === "Bijan");
    assert.deepEqual(bijan, {
      id: 2,
      name: "Bijan",
      proTeamId: 1,
      eligibleSlots: [2, 23],
      currentSlot: 2,
      projectedPoints: 17.4,
    });
  });

  test("sends the period as a query param and the views in the URL", async () => {
    fixture.rosters = [fx.rosterResponse()];
    await optimize.fetchTeam(8);
    const read = calls.find((c) => c.url.includes("lm-api-reads"));
    assert.deepEqual(read.params, { scoringPeriodId: 8 });
    for (const view of ["mRoster", "mTeam", "mStatus", "mSettings"]) {
      assert.match(read.url, new RegExp(`view=${view}`));
    }
  });

  test("throws when the team is not in the league", async () => {
    fixture.rosters = [fx.rosterResponse({ teamId: 99 })];
    await assert.rejects(optimize.fetchTeam(8), /Team 10 not found/);
  });

  test("throws when the response has no teams", async () => {
    fixture.rosters = [{ teams: [] }];
    await assert.rejects(optimize.fetchTeam(8), /No team data/);
  });

  test("throws when the team has no roster entries", async () => {
    fixture.rosters = [{ teams: [{ id: 10, name: "Empty" }] }];
    await assert.rejects(optimize.fetchTeam(8), /No roster entries/);
  });

  test("skips entries without a player", async () => {
    fixture.rosters = [fx.rosterResponse({ entries: [{ lineupSlotId: 0, playerPoolEntry: {} }] })];
    const team = await optimize.fetchTeam(8);
    assert.equal(team.players.length, 0);
  });

  test("lineup slot counts default to empty when settings are missing", async () => {
    fixture.rosters = [{ teams: [{ id: 10, name: "x", roster: { entries: [] } }] }];
    const team = await optimize.fetchTeam(8);
    assert.deepEqual(team.lineupSlotCounts, {});
  });
});

describe("verify", () => {
  const moves = [{ playerId: 3, name: "Love", fromSlot: BENCH, toSlot: 2 }];

  test("passes when the roster shows every move", async () => {
    const after = fx.standardEntries().map((e) =>
      e.playerPoolEntry.player.id === 3 ? { ...e, lineupSlotId: 2 } : e,
    );
    fixture.rosters = [fx.rosterResponse({ entries: after })];
    assert.equal(await optimize.verify(moves, 8), true);
  });

  test("fails when the roster does not show a move after re-reading", async () => {
    fixture.rosters = [fx.rosterResponse()];
    assert.equal(await optimize.verify(moves, 8), false);
  });

  test("passes when the roster catches up on a later read", async () => {
    const after = fx.standardEntries().map((e) =>
      e.playerPoolEntry.player.id === 3 ? { ...e, lineupSlotId: 2 } : e,
    );
    fixture.rosters = [fx.rosterResponse(), fx.rosterResponse({ entries: after })];
    assert.equal(await optimize.verify(moves, 8), true);
  });
});
