const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { install } = require("./helpers/axios-stub");
install({});

const plan = require(path.join(__dirname, "..", "plan-schedule.js"));
const { event } = require("./helpers/fixtures");

const WORKFLOW_PATH = path.join(__dirname, "..", ".github", "workflows", "lineup.yml");

const template = (body) =>
  [
    "on:",
    "  schedule:",
    "    # BEGIN generated schedule",
    ...body,
    "    # END generated schedule",
    "  workflow_dispatch:",
    "jobs: {}",
    "",
  ].join("\n");

describe("cronFor", () => {
  test("runs one hour before kickoff, in UTC", () => {
    assert.equal(plan.cronFor("2026-11-01T18:00Z"), "0 17 1 11 *");
    assert.equal(plan.cronFor("2026-11-01T20:25Z"), "25 19 1 11 *");
  });

  test("rounds the minute down to a multiple of 5", () => {
    // 18:07 minus an hour is 17:07, which rounds down to 17:05.
    assert.equal(plan.cronFor("2026-11-01T18:07Z"), "5 17 1 11 *");
    assert.equal(plan.cronFor("2026-11-01T18:04Z"), "0 17 1 11 *");
  });

  test("crosses midnight into the previous day", () => {
    // A 00:15 UTC kickoff on the 2nd runs at 23:15 UTC on the 1st.
    assert.equal(plan.cronFor("2026-11-02T00:15Z"), "15 23 1 11 *");
  });

  test("crosses the year boundary", () => {
    assert.equal(plan.cronFor("2027-01-01T00:30Z"), "30 23 31 12 *");
  });
});

describe("upcomingGames", () => {
  const now = Date.now();
  const at = (minutes, state = "pre", shortName = "A @ B") => event({ minutes, state, shortName });

  test("keeps scheduled games whose trigger is still in the future", () => {
    const games = plan.upcomingGames([at(180), at(90, "pre", "C @ D")], now);
    assert.deepEqual(games.map((g) => g.game), ["A @ B", "C @ D"]);
  });

  test("drops games that have started or finished", () => {
    assert.deepEqual(plan.upcomingGames([at(180, "in"), at(180, "post")], now), []);
  });

  test("drops games whose lead-time run has already passed", () => {
    // 30 minutes away means the 60-minute-before run was 30 minutes ago.
    assert.deepEqual(plan.upcomingGames([at(30)], now), []);
  });

  test("handles a missing events list", () => {
    assert.deepEqual(plan.upcomingGames(undefined, now), []);
  });

  test("each game carries its cron, name and kickoff", () => {
    const [game] = plan.upcomingGames([at(180, "pre", "CAR @ GB")], now);
    assert.match(game.cron, /^\d+ \d+ \d+ \d+ \*$/);
    assert.equal(game.game, "CAR @ GB");
    assert.ok(game.kickoff);
  });
});

describe("cronLines", () => {
  test("sorts and removes duplicates", () => {
    const lines = plan.cronLines([
      { cron: "0 17 1 11 *" },
      { cron: "0 20 1 11 *" },
      { cron: "0 17 1 11 *" },
    ]);
    assert.deepEqual(lines, ["0 17 1 11 *", "0 20 1 11 *"]);
  });

  test("falls back to the placeholder when nothing is upcoming", () => {
    assert.deepEqual(plan.cronLines([]), [plan.PLACEHOLDER]);
  });

  test("the placeholder fires once a year", () => {
    assert.equal(plan.PLACEHOLDER, "0 0 1 1 *");
  });
});

describe("renderSchedule", () => {
  test("replaces the lines between the markers", () => {
    const out = plan.renderSchedule(template(['    - cron: "0 0 1 1 *"']), ["0 17 1 11 *", "0 20 1 11 *"]);
    assert.equal(
      out,
      template(['    - cron: "0 17 1 11 *"', '    - cron: "0 20 1 11 *"']),
    );
  });

  test("keeps the text around the markers untouched", () => {
    const original = template(['    - cron: "0 0 1 1 *"']);
    const out = plan.renderSchedule(original, ["5 5 5 5 *"]);
    assert.ok(out.startsWith("on:\n  schedule:\n    # BEGIN generated schedule\n"));
    assert.ok(out.endsWith("    # END generated schedule\n  workflow_dispatch:\njobs: {}\n"));
  });

  test("is idempotent: rendering the same lines twice changes nothing more", () => {
    const once = plan.renderSchedule(template([]), ["0 17 1 11 *"]);
    const twice = plan.renderSchedule(once, ["0 17 1 11 *"]);
    assert.equal(twice, once);
  });

  test("replaces leftover lines from an earlier run, not just the placeholder", () => {
    const out = plan.renderSchedule(template(['    - cron: "1 1 1 1 *"', '    - cron: "2 2 2 2 *"']), ["9 9 9 9 *"]);
    assert.equal(out, template(['    - cron: "9 9 9 9 *"']));
  });

  test("throws when the BEGIN marker is missing", () => {
    const broken = template([]).replace("# BEGIN generated schedule", "# BEGIN something else");
    assert.throws(() => plan.renderSchedule(broken, ["0 0 1 1 *"]), /markers not found/);
  });

  test("throws when the END marker is missing", () => {
    const broken = template([]).replace("# END generated schedule", "# END something else");
    assert.throws(() => plan.renderSchedule(broken, ["0 0 1 1 *"]), /markers not found/);
  });

  test("throws instead of inserting lines when the markers are missing but cron lines exist", () => {
    const text = 'on:\n  schedule:\n    - cron: "0 17 1 11 *"\n';
    assert.throws(() => plan.renderSchedule(text, ["0 17 1 11 *"]), /markers not found/);
  });
});

describe("the real lineup workflow", () => {
  const text = fs.readFileSync(WORKFLOW_PATH, "utf8");

  test("has the schedule markers the planner needs", () => {
    assert.match(text, /^    # BEGIN generated schedule$/m);
    assert.match(text, /^    # END generated schedule$/m);
  });

  test("renders cleanly with the placeholder", () => {
    const out = plan.renderSchedule(text, [plan.PLACEHOLDER]);
    assert.match(out, /^    - cron: "0 0 1 1 \*"$/m);
  });

  test("the planner checks WORKFLOW_TOKEN before checkout uses it", () => {
    const planner = fs.readFileSync(path.join(__dirname, "..", ".github", "workflows", "plan-schedule.yml"), "utf8");
    const check = planner.indexOf("Check WORKFLOW_TOKEN is set");
    const checkout = planner.indexOf("uses: actions/checkout");
    assert.ok(check > -1 && checkout > -1, "both steps must exist");
    assert.ok(check < checkout, "the token check must run before checkout");
  });

  test("runs --auto on schedule and --write on a manual run", () => {
    assert.match(text, /node optimize\.js --auto/);
    assert.match(text, /node optimize\.js --write/);
    assert.match(text, /node optimize\.js\s+# manual/);
  });
});
