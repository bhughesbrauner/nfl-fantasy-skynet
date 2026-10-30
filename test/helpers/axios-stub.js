// Replaces the axios module with a stub that answers from a fixture object.
// Lets the tests run optimize.js and plan-schedule.js without touching the network.
//
// fixture shape:
//   events:        scoreboard events (returned for any GET to site.api.espn.com)
//   scoreboardError: string; if set, the scoreboard GET throws with this message
//   rosters:       array of fantasy API responses; the Nth roster read gets rosters[N],
//                  and reads past the end repeat the last entry
//   postError:     { status, data } to make the lineup POST fail the way axios does
//
// Returns { calls }, the recorded GET and POST calls in order.

const Module = require("module");

function install(fixture) {
  const calls = [];

  const stub = {
    async get(url, opts = {}) {
      calls.push({ method: "GET", url, params: opts.params, headers: opts.headers });
      if (url.startsWith("https://site.api.espn.com/")) {
        if (fixture.scoreboardError) throw new Error(fixture.scoreboardError);
        return { data: { events: fixture.events || [] } };
      }
      if (url.includes("lm-api-reads")) {
        const seq = fixture.rosters || [];
        if (seq.length === 0) throw new Error("fixture has no rosters");
        // The read count lives on the fixture so each test can reset it.
        const reads = fixture.readCount || 0;
        fixture.readCount = reads + 1;
        return { data: seq[Math.min(reads, seq.length - 1)] };
      }
      throw new Error(`unexpected GET ${url}`);
    },
    async post(url, body, opts = {}) {
      calls.push({ method: "POST", url, body, headers: opts.headers });
      if (fixture.postError) {
        const err = new Error(`Request failed with status code ${fixture.postError.status}`);
        err.response = { status: fixture.postError.status, data: fixture.postError.data };
        throw err;
      }
      return { status: 200, data: {} };
    },
  };

  const file = require.resolve("axios");
  const mod = new Module(file, null);
  mod.filename = file;
  mod.loaded = true;
  mod.exports = stub;
  require.cache[file] = mod;

  return { calls };
}

module.exports = { install };
