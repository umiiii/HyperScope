import { createServer } from "node:http";
import { closeDatabase, ensureSchema } from "@/lib/db";
import {
  drainNotificationOutbox,
  listDueAddressIds,
  monitorAddress,
  updateWorkerState,
  withMonitorLease,
} from "@/lib/monitor";
import { getMonitorIntervalMs } from "@/lib/repository/addresses";

let stopping = false;
let ready = false;
let wakeSleep: (() => void) | null = null;

const healthServer = createServer((request, response) => {
  if (request.url !== "/health") {
    response.writeHead(404).end();
    return;
  }

  const healthy = ready && !stopping;
  response.writeHead(healthy ? 200 : 503, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify({ status: healthy ? "ok" : "starting" }));
});

function listenForHealthchecks() {
  const configuredPort = Number(process.env.PORT || 3001);
  const port =
    Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort <= 65_535
      ? configuredPort
      : 3001;

  return new Promise<void>((resolve, reject) => {
    const handleError = (error: Error) => reject(error);
    healthServer.once("error", handleError);
    healthServer.listen(port, "0.0.0.0", () => {
      healthServer.off("error", handleError);
      console.log(`Worker healthcheck listening on port ${port}.`);
      resolve();
    });
  });
}

function closeHealthcheckServer() {
  if (!healthServer.listening) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    healthServer.close((error) => (error ? reject(error) : resolve()));
  });
}

function wait(milliseconds: number) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      wakeSleep = null;
      resolve();
    }, milliseconds);
    wakeSleep = () => {
      clearTimeout(timer);
      wakeSleep = null;
      resolve();
    };
  });
}

function requestStop(signal: string) {
  console.log(`Received ${signal}; finishing the current monitor cycle.`);
  stopping = true;
  ready = false;
  wakeSleep?.();
}

process.once("SIGTERM", () => requestStop("SIGTERM"));
process.once("SIGINT", () => requestStop("SIGINT"));

async function runCycle() {
  await withMonitorLease(async () => {
    await updateWorkerState("running");
    const addressIds = await listDueAddressIds();

    for (let offset = 0; offset < addressIds.length && !stopping; offset += 10) {
      const batch = addressIds.slice(offset, offset + 10);
      await Promise.all(
        batch.map(async (addressId) => {
          try {
            const result = await monitorAddress(addressId);
            if (!result.success) {
              console.warn(`Monitor failed for ${addressId}: ${result.error}`);
            } else if (result.changes.length > 0) {
              const muted = result.changes.length - result.notified.length;
              console.log(
                `Detected ${result.changes.length} position changes for ${addressId}` +
                  (muted > 0 ? `; ${muted} muted by the push cooldown.` : "."),
              );
            }
          } catch (error) {
            console.error(`Unexpected monitor failure for ${addressId}`, error);
          }
        }),
      );
    }

    await drainNotificationOutbox();
    await updateWorkerState("idle");
  });
}

async function main() {
  await ensureSchema();
  await updateWorkerState("starting");
  await listenForHealthchecks();
  ready = true;
  const interval = getMonitorIntervalMs();
  console.log(`HyperScope monitor worker started; interval=${interval}ms.`);

  while (!stopping) {
    const startedAt = Date.now();
    try {
      await runCycle();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Monitor cycle failed", error);
      await updateWorkerState("error", message.slice(0, 500)).catch(() => undefined);
    }

    if (!stopping) {
      await wait(Math.max(1_000, interval - (Date.now() - startedAt)));
    }
  }

  await updateWorkerState("stopping").catch(() => undefined);
  await closeHealthcheckServer().catch(() => undefined);
  await closeDatabase();
  console.log("HyperScope monitor worker stopped.");
}

main().catch(async (error) => {
  console.error("Monitor worker crashed during startup", error);
  ready = false;
  await closeHealthcheckServer().catch(() => undefined);
  await closeDatabase().catch(() => undefined);
  process.exitCode = 1;
});
