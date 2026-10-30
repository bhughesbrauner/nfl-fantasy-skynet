// Runs optimize.js as a child process, the way the workflow and a person at a terminal do.
// axios is stubbed by test/helpers/preload.js, so nothing reaches ESPN.

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const fx = require("./helpers/fixtures");

const ROOT = path.join(__dirname, "..");
const OPTIMIZE = path.join(ROOT, "optimize.js");
const PRELOAD = path.join(__dirname, "helpers", "preload.js");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "optimize-cli-"));

let runCounter = 0;

// Runs optimize.js with the given args and fixture. Returns exit status, output, and ESPN calls.
function run(args, fixture, extraEnv = {}) {
  runCounter += 1;
  const fixturePath = path.join(tmp, `fixture-${runCounter}.json`);
  const logPath = path.join(tmp, `calls-${runCounter}.json`);
  fs.writeFileSync(fixturePath, JSON.stringify(fixture));

  const env = {
    PATH: process.env.PATH,
    LEAGUE_ID: "1111242860",
    TEAM_ID: String(fx.TEAM_ID),
    SWID: "{TEST-SWID}",
    ESPN_S2: "test-espn-s2",
    VERIFY_DELAYS_MS: "[0,0,0]",
    STUB_FIXTURE: fixturePath,
    STUB_LOG: logPath,
    ...extraEnv,
  };
  // Missing-config tests pass undefined to remove a variable.
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];

  const result = spawnSync(process.execPath, ["-r", PRELOAD, OPTIMIZE, ...args], {
    cwd: ROOT,
    env,
    encoding: "utf8",
    timeout: 30000,
  });

  const calls = fs.existsSync(logPath) ? JSON.parse(fs.readFileSync(logPath, "utf8")) : [];
  return {
    status: result.status,
    out: result.stdout + result.stderr,
    calls,
    posts: calls.filter((c) => c.method === "POST"),
  };
}

// A roster that matches the standard fixture, with some slots changed.
function rosterWith(changes = {}) {
  const entries = fx.standardEntries().map((e) => {
    const id = e.playerPoolEntry.player.id;
    return changes[id] !== undefined ? { ...e, lineupSlotId: changes[id] } : e;
  });
  return fx.rosterResponse({ entries });
}

// The standard fixture: a week with kickoffs in the window, nothing locked yet.
const inWindow = () => [fx.event({ minutes: 30, teams: [50, 51], shortName: "X @ Y" })];
const farAway = () => [fx.event({ minutes: 60 * 24 * 3, teams: [50, 51], shortName: "X @ Y" })];

// The optimum for the standard roster: Love (bench) moves into the second RB slot.
const BEFORE = rosterWith({});
const AFTER_LOVE_STARTS = rosterWith({ 3: 2 });

describe("dry run (no flags)", () => {
  test("prints the plan and the request, sends nothing", () => {
    const r = run([], { events: farAway(), rosters: [BEFORE] });
    assert.equal(r.status, 0);
    assert.match(r.out, /Dry run\. Nothing sent/);
    assert.match(r.out, /Moves needed: 1/);
    assert.match(r.out, /Love.*BE -> RB/);
    assert.equal(r.posts.length, 0);
  });

  test("the printed request body moves Love into the RB slot", () => {
    const r = run([], { events: farAway(), rosters: [BEFORE] });
    // Parse from the brace after the label, not the first brace in the output (dotenv prints one).
    const after = r.out.slice(r.out.indexOf("Request body that would be sent:"));
    const body = JSON.parse(after.slice(after.indexOf("{"), after.lastIndexOf("}") + 1));
    assert.deepEqual(body.items, [{ playerId: 3, type: "LINEUP", fromLineupSlotId: 20, toLineupSlotId: 2 }]);
  });

  test("prints the optimized lineup with the projected total", () => {
    const r = run([], { events: farAway(), rosters: [BEFORE] });
    assert.match(r.out, /=== OPTIMIZED LINEUP ===/);
    assert.match(r.out, /Total projected:/);
  });

  test("says so when the lineup is already optimal", () => {
    const r = run([], { events: farAway(), rosters: [AFTER_LOVE_STARTS] });
    assert.equal(r.status, 0);
    assert.match(r.out, /already matches the optimum/);
    assert.equal(r.posts.length, 0);
  });

  test("lists locked players and keeps them in place", () => {
    // Team 1 (Bijan, London, Pitts) has a game in progress.
    const live = [fx.event({ state: "in", minutes: -30, teams: [1, 60], shortName: "A @ B" })];
    const r = run([], { events: [...live, ...farAway()], rosters: [BEFORE] });
    assert.equal(r.status, 0);
    assert.match(r.out, /Locked \(game started or finished\)/);
    assert.match(r.out, /Bijan/);
    assert.match(r.out, /London/);
    assert.match(r.out, /Pitts/);
    assert.doesNotMatch(r.out, /Bijan\s+RB -> /);
  });

  test("never plans or moves the IR player", () => {
    const r = run([], { events: farAway(), rosters: [BEFORE] });
    assert.doesNotMatch(r.out, /IR Star/);
  });

  test("refuses to plan when a player sits in a slot the league does not use", () => {
    const odd = rosterWith({ 4: 3 }); // slot 3 is not in the league's counts
    const r = run([], { events: farAway(), rosters: [odd] });
    assert.equal(r.status, 1);
    assert.match(r.out, /slots the league does not use/);
    assert.match(r.out, /London/);
    assert.equal(r.posts.length, 0);
  });

  test("a period older than ESPN's current one is refused", () => {
    const r = run(["--period=3"], { events: farAway(), rosters: [BEFORE] });
    assert.equal(r.status, 1);
    assert.match(r.out, /before ESPN's current period/);
  });

  test("an explicit --period newer than current is used for the read", () => {
    const r = run(["--period=9"], { events: farAway(), rosters: [BEFORE, BEFORE] });
    const reads = r.calls.filter((c) => c.method === "GET" && c.url.includes("lm-api-reads"));
    assert.ok(reads.some((c) => c.params && c.params.scoringPeriodId === 9));
  });
});

describe("--auto (scheduled run)", () => {
  test("exits quietly when no game kicks off inside the window", () => {
    const r = run(["--auto"], { events: farAway(), rosters: [BEFORE] });
    assert.equal(r.status, 0);
    assert.match(r.out, /Nothing to do/);
    assert.equal(r.posts.length, 0);
  });

  test("when a kickoff is inside the window, sends the lineup change", () => {
    const r = run(["--auto"], { events: inWindow(), rosters: [BEFORE, BEFORE, AFTER_LOVE_STARTS] });
    assert.equal(r.status, 0, r.out);
    assert.equal(r.posts.length, 1);
    assert.equal(r.posts[0].url.includes("lm-api-writes"), true);
    assert.equal(r.posts[0].body.items[0].toLineupSlotId, 2);
    assert.match(r.out, /Verified: every move is on the roster read-back/);
  });

  test("the write call sends the cookies and a JSON content type", () => {
    const r = run(["--auto"], { events: inWindow(), rosters: [BEFORE, BEFORE, AFTER_LOVE_STARTS] });
    assert.equal(r.posts[0].headers.Cookie, "SWID={TEST-SWID}; espn_s2=test-espn-s2");
    assert.equal(r.posts[0].headers["Content-Type"], "application/json");
  });

  test("a kickoff in the window with nothing to change sends nothing", () => {
    const r = run(["--auto"], { events: inWindow(), rosters: [AFTER_LOVE_STARTS] });
    assert.equal(r.status, 0);
    assert.match(r.out, /already matches the optimum/);
    assert.equal(r.posts.length, 0);
  });
});

describe("--write (manual run)", () => {
  test("sends the change even outside a kickoff window", () => {
    const r = run(["--write"], { events: farAway(), rosters: [BEFORE, BEFORE, AFTER_LOVE_STARTS] });
    assert.equal(r.status, 0, r.out);
    assert.equal(r.posts.length, 1);
  });

  test("exits 1 when the roster does not show the move after re-reading", () => {
    const r = run(["--write"], { events: farAway(), rosters: [BEFORE] });
    assert.equal(r.posts.length, 1, "the write is still sent");
    assert.equal(r.status, 1);
    assert.match(r.out, /Mismatches after re-reading/);
    assert.match(r.out, /Love: expected RB, roster shows BE/);
  });

  test("a rejected write exits 1 and prints ESPN's error body", () => {
    const r = run(["--write"], {
      events: farAway(),
      rosters: [BEFORE],
      postError: { status: 409, data: { message: "locked" } },
    });
    assert.equal(r.status, 1);
    assert.match(r.out, /status code 409/);
    assert.match(r.out, /ESPN said: .*locked/);
  });

  test("never sends anything when no move is needed", () => {
    const r = run(["--write"], { events: farAway(), rosters: [AFTER_LOVE_STARTS] });
    assert.equal(r.status, 0);
    assert.equal(r.posts.length, 0);
  });
});

describe("failure paths", () => {
  test("a scoreboard failure stops the run before any write", () => {
    const r = run(["--write"], { scoreboardError: "ESPN is down", rosters: [BEFORE] });
    assert.equal(r.status, 1);
    assert.match(r.out, /ESPN is down/);
    assert.equal(r.posts.length, 0);
  });

  test("a team that is not in the league stops the run", () => {
    const r = run([], { events: farAway(), rosters: [fx.rosterResponse({ teamId: 99 })] });
    assert.equal(r.status, 1);
    assert.match(r.out, /Team 10 not found/);
  });

  test("a league with no roster response stops the run", () => {
    const r = run([], { events: farAway(), rosters: [{ teams: [] }] });
    assert.equal(r.status, 1);
    assert.match(r.out, /No team data/);
  });

  test("missing config stops the run before any network call", () => {
    // An empty value, not an absent one: dotenv would fill an absent value from a local .env file.
    const r = run([], { events: farAway(), rosters: [BEFORE] }, { LEAGUE_ID: "" });
    assert.equal(r.status, 1);
    assert.match(r.out, /Missing LEAGUE_ID, TEAM_ID, SWID or ESPN_S2/);
    assert.equal(r.calls.length, 0);
  });

  test("a missing ESPN period in the response stops the run", () => {
    const noPeriod = fx.rosterResponse();
    delete noPeriod.status;
    const r = run([], { events: farAway(), rosters: [noPeriod] });
    assert.equal(r.status, 1);
    assert.match(r.out, /no status\.latestScoringPeriod/);
  });
});
