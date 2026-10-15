import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const app = buildApp({ config, logger: true });

try {
  const address = await app.listen({ host: config.host, port: config.port });
  app.log.info({ address }, "Esure backend is listening");
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}

// ── Graceful-shutdown lifecycle ──────────────────────────────────────────────
//
// SIGTERM and SIGINT each trigger shutdown exactly once.  The sequence is:
//   1. Mark the RunService as draining — new run POSTs get 503 immediately.
//   2. Close the HTTP listener so no new connections are accepted.
//   3. Wait for all active executions to finish, capped at DRAIN_TIMEOUT_MS.
//      Any run still executing when the deadline expires keeps running to
//      completion inside execute(), but we stop waiting and move on.
//   4. Close Fastify (which fires onClose hooks, releasing DB pools / timers).
//   5. Exit.  If anything throws we still exit, just with code 1.

const DRAIN_TIMEOUT_MS = 30_000;

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  app.log.info({ signal }, "Shutdown signal received — draining active runs");

  // Stop accepting new runs immediately.
  app.runs.drain().catch(() => undefined);

  // Stop the HTTP listener (returns 503 for in-flight requests that haven't
  // been routed yet and closes keep-alive sockets).
  try {
    await app.close();
  } catch (closeError) {
    app.log.error(closeError, "Error while closing the HTTP listener");
  }

  // Wait for active executions up to the grace period.
  const drainDeadline = new Promise<void>((resolve) => setTimeout(resolve, DRAIN_TIMEOUT_MS).unref());
  await Promise.race([app.runs.drain(), drainDeadline]);

  app.log.info("Shutdown complete");
  process.exit(0);
}

process.once("SIGTERM", () => { shutdown("SIGTERM").catch((err) => { app.log.error(err, "Fatal during SIGTERM shutdown"); process.exit(1); }); });
process.once("SIGINT",  () => { shutdown("SIGINT").catch((err)  => { app.log.error(err, "Fatal during SIGINT shutdown");  process.exit(1); }); });
