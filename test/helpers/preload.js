// Loaded with `node -r` by the CLI tests. When STUB_FIXTURE points at a JSON fixture,
// axios is stubbed before optimize.js loads. On exit, the recorded calls are written to STUB_LOG.

const fs = require("fs");
const { install } = require("./axios-stub");

if (process.env.STUB_FIXTURE) {
  const fixture = JSON.parse(fs.readFileSync(process.env.STUB_FIXTURE, "utf8"));
  const { calls } = install(fixture);
  process.on("exit", () => {
    if (process.env.STUB_LOG) fs.writeFileSync(process.env.STUB_LOG, JSON.stringify(calls));
  });
}
