// Rewrites the cron entries in .github/workflows/lineup.yml so the lineup job runs
// 60 minutes before each game that has not kicked off yet. Run daily by plan-schedule.yml.
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

// Cron runs in UTC. Minutes are rounded down to a multiple of 5, which only makes the run earlier.
function cronFor(isoDate) {
  const trigger = new Date(Date.parse(isoDate) - LEAD_MINUTES * 60000);
  const minute = Math.floor(trigger.getUTCMinutes() / 5) * 5;
  return `${minute} ${trigger.getUTCHours()} ${trigger.getUTCDate()} ${trigger.getUTCMonth() + 1} *`;
}

// Games that have not kicked off and whose lead-time run is still in the future.
function upcomingGames(events, now) {
  return (events || [])
    .filter((e) => e.status?.type?.state === "pre")
    .filter((e) => Date.parse(e.date) - LEAD_MINUTES * 60000 > now)
    .map((e) => ({ cron: cronFor(e.date), game: e.shortName, kickoff: e.date }));
}

// Sorted, de-duplicated cron lines. Falls back to the placeholder when nothing is upcoming.
function cronLines(upcoming) {
  const crons = [...new Set(upcoming.map((u) => u.cron))].sort();
  return crons.length > 0 ? crons : [PLACEHOLDER];
}

// Returns the workflow text with the lines between the markers replaced.
// Throws when either marker is missing, so the planner never guesses where the lines go.
function renderSchedule(original, lines) {
  const begin = /^    # BEGIN generated schedule$/m;
  const end = /^    # END generated schedule$/m;
  if (!begin.test(original) || !end.test(original)) {
    throw new Error("BEGIN/END schedule markers not found in the workflow. Refusing to guess where the cron lines go.");
  }
  const body = lines.map((c) => `    - cron: "${c}"`).join("\n") + "\n";
  return original.replace(
    /(^    # BEGIN generated schedule\n)[\s\S]*?(^    # END generated schedule$)/m,
    (_, head, tail) => `${head}${body}${tail}`,
  );
}

async function main() {
  const { data } = await axios.get(SCOREBOARD_URL);
  const upcoming = upcomingGames(data.events, Date.now());
  const lines = cronLines(upcoming);

  upcoming.forEach((u) => console.log(`${u.game} kicks off ${u.kickoff} -> cron "${u.cron}"`));
  if (upcoming.length === 0) console.log("No upcoming games. Writing placeholder schedule.");

  const original = fs.readFileSync(WORKFLOW, "utf8");
  const updated = renderSchedule(original, lines);
  if (updated === original) {
    console.log("Schedule unchanged.");
    return;
  }
  fs.writeFileSync(WORKFLOW, updated);
  console.log(`Wrote ${lines.length} schedule entr${lines.length === 1 ? "y" : "ies"} to ${WORKFLOW}.`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error("Error:", error.message);
    process.exit(1);
  });
}

module.exports = { cronFor, upcomingGames, cronLines, renderSchedule, PLACEHOLDER, LEAD_MINUTES };
