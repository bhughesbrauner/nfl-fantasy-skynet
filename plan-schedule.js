// Rewrites the cron entries in .github/workflows/lineup.yml so the lineup job runs
// 60 minutes before each game that has not kicked off yet. Run daily by plan-schedule.yml.
//
// Each entry gets a comment with the time it runs in Spokane, WA. Spokane is on Pacific time.
//
// Entries go between the BEGIN and END markers in lineup.yml. If no games are upcoming,
// a placeholder entry that fires once a year is written, because an empty schedule
// list is not valid YAML.

const fs = require("fs");
const axios = require("axios");

const SCOREBOARD_URL = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard";
const WORKFLOW = ".github/workflows/lineup.yml";
const LEAD_MINUTES = 60;
const PLACEHOLDER = "0 0 1 1 *";
const LOCAL_TZ = "America/Los_Angeles"; // Spokane is on Pacific time (PST or PDT, by date)

// The run time: 60 minutes before kickoff, rounded down to a multiple of 5 minutes.
// Rounding down only makes the run earlier, and the optimizer's window covers that.
function triggerFor(isoDate) {
  const t = new Date(Date.parse(isoDate) - LEAD_MINUTES * 60000);
  t.setUTCMinutes(Math.floor(t.getUTCMinutes() / 5) * 5, 0, 0);
  return t;
}

// Cron runs in UTC, so the fields come from UTC.
function cronFromDate(d) {
  return `${d.getUTCMinutes()} ${d.getUTCHours()} ${d.getUTCDate()} ${d.getUTCMonth() + 1} *`;
}

function cronFor(isoDate) {
  return cronFromDate(triggerFor(isoDate));
}

// "Sun, Nov 1, 9:00 AM PST" for a date, shown in Pacific time.
function localTime(d) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: LOCAL_TZ,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(d);
}

// Games that have not kicked off and whose run is still in the future.
function upcomingGames(events, now) {
  return (events || [])
    .filter((e) => e.status?.type?.state === "pre")
    .map((e) => ({ trigger: triggerFor(e.date), game: e.shortName, kickoff: e.date }))
    .filter((u) => u.trigger.getTime() > now)
    .map((u) => ({ ...u, cron: cronFromDate(u.trigger) }));
}

// One entry per distinct run time, earliest first, each with the games it covers.
// Falls back to a placeholder when nothing is upcoming.
function scheduleEntries(upcoming) {
  if (upcoming.length === 0) {
    return [{ cron: PLACEHOLDER, comment: "placeholder: fires once a year and does nothing" }];
  }
  const byCron = new Map();
  for (const u of upcoming) {
    if (!byCron.has(u.cron)) byCron.set(u.cron, { cron: u.cron, trigger: u.trigger, games: [] });
    byCron.get(u.cron).games.push(u.game);
  }
  return [...byCron.values()]
    .sort((a, b) => a.trigger - b.trigger)
    .map((e) => ({
      cron: e.cron,
      comment: `runs ${localTime(e.trigger)} in Spokane, WA (before ${e.games.join(", ")})`,
    }));
}

// Returns the workflow text with the entries between the markers replaced.
// Throws when either marker is missing, so the planner never guesses where the lines go.
function renderSchedule(original, entries) {
  const begin = /^    # BEGIN generated schedule$/m;
  const end = /^    # END generated schedule$/m;
  if (!begin.test(original) || !end.test(original)) {
    throw new Error("BEGIN/END schedule markers not found in the workflow. Refusing to guess where the cron lines go.");
  }
  const body = entries.map((e) => `    - cron: "${e.cron}"  # ${e.comment}`).join("\n") + "\n";
  return original.replace(
    /(^    # BEGIN generated schedule\n)[\s\S]*?(^    # END generated schedule$)/m,
    (_, head, tail) => `${head}${body}${tail}`,
  );
}

async function main() {
  const { data } = await axios.get(SCOREBOARD_URL);
  const upcoming = upcomingGames(data.events, Date.now());
  const entries = scheduleEntries(upcoming);

  upcoming.forEach((u) => console.log(`${u.game} kicks off ${u.kickoff} -> cron "${u.cron}"`));
  if (upcoming.length === 0) console.log("No upcoming games. Writing placeholder schedule.");

  const original = fs.readFileSync(WORKFLOW, "utf8");
  const updated = renderSchedule(original, entries);
  if (updated === original) {
    console.log("Schedule unchanged.");
    return;
  }
  fs.writeFileSync(WORKFLOW, updated);
  console.log(`Wrote ${entries.length} schedule entr${entries.length === 1 ? "y" : "ies"} to ${WORKFLOW}.`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error("Error:", error.message);
    process.exit(1);
  });
}

module.exports = {
  cronFor,
  triggerFor,
  upcomingGames,
  scheduleEntries,
  renderSchedule,
  localTime,
  PLACEHOLDER,
  LEAD_MINUTES,
};
