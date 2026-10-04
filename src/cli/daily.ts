import { openSqlitePreparedArtifactStore } from "../adapters/sqlite/prepared-artifact-store.js";
import { createDailyPrepareComposition } from "../application/daily-prepare-composition.js";
import { localOperatorIdentity } from "../application/local-operator.js";
import { systemClock } from "../domain/shared/time.js";
import { promptVisible } from "./interactive-prompt.js";
import { runDailyCommand } from "./daily-command.js";

// Construct live composition only for a validated prepare invocation. Offline
// review and consent do not read Keychain, recollect, reprice or re-run risk.
process.exitCode = await runDailyCommand(process.argv.slice(2), {
  prepare: (input) => createDailyPrepareComposition().prepare(input),
  openStore: (environment) => openSqlitePreparedArtifactStore({ environment }),
  actor: localOperatorIdentity,
  clock: systemClock,
  interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
  prompt: (label) => promptVisible(label),
  write: (text) => console.log(text),
});
