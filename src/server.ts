import { createHash, timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import { loadConfig } from './config.js';
import { SyncService } from './sync.js';

const config = loadConfig();
const service = new SyncService(config);

const app = Fastify({ logger: true });

// /sync is triggered by the x-webhook-secret header and ignores the body.
// Accept any content type (Home Assistant's rest_command sends
// application/octet-stream by default, which Fastify otherwise 415s on).
app.addContentTypeParser('*', (_request, _payload, done) => done(null, undefined));

// Compare SHA-256 digests rather than the raw strings: timingSafeEqual requires
// equal-length buffers, and a plain length check before it would leak the
// secret's length. Hashing makes both sides a fixed 32 bytes.
const expectedDigest = createHash('sha256').update(config.webhookSecret).digest();

function secretOk(provided: string | undefined): boolean {
  if (!provided) return false;
  return timingSafeEqual(createHash('sha256').update(provided).digest(), expectedDigest);
}

app.get('/health', async () => ({ ok: true }));

app.post('/sync', async (request, reply) => {
  const provided = request.headers['x-webhook-secret'];
  if (!secretOk(Array.isArray(provided) ? provided[0] : provided)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }

  // Log the detail, never return it: exception text can carry filesystem paths
  // or raw upstream API responses. The container log is the place for that.
  const failed = { error: 'sync failed', hint: 'see the service logs for details' };

  try {
    const result = await service.runSync();
    // A batch tolerates one bad activity, but this route syncs exactly one — so
    // a failure here is the whole request failing, and shouldn't look like a 200.
    if (result.status === 'failed') {
      request.log.error({ result }, 'sync failed');
      return reply.code(500).send(failed);
    }
    return reply.code(200).send(result);
  } catch (err) {
    request.log.error(err);
    return reply.code(500).send(failed);
  }
});

/**
 * Per-set history for other tools (spreadsheets, dashboards). Read-only.
 * ?since=YYYY-MM-DD limits it to workouts on or after that date; without it,
 * every workout is fetched, which takes a few minutes for a long history.
 */
app.get('/sets', async (request, reply) => {
  const provided = request.headers['x-webhook-secret'];
  if (!secretOk(Array.isArray(provided) ? provided[0] : provided)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  const since = (request.query as { since?: string }).since;
  if (since !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
    return reply.code(400).send({ error: 'since must be YYYY-MM-DD' });
  }
  try {
    return reply.code(200).send(await service.setHistory(since));
  } catch (err) {
    request.log.error(err);
    return reply.code(500).send({ error: 'set history failed', hint: 'see the service logs for details' });
  }
});

/**
 * Optional polling loop. Required on iOS, where no app may read another app's
 * notifications and so the Home Assistant trigger cannot exist; useful on
 * Android as a backstop for missed notifications and downtime.
 *
 * A tick that finds nothing new costs one Tonal summaries call and returns
 * "skipped" — dedup makes over-polling harmless, so failures here only ever log.
 */
function startPolling(): void {
  if (config.pollIntervalMinutes <= 0) return;
  const everyMs = config.pollIntervalMinutes * 60_000;

  const tick = async (): Promise<void> => {
    try {
      const results = await service.runSyncRecent(config.pollLookback);
      const synced = results.filter((r) => r.status === 'synced');
      if (synced.length > 0) {
        app.log.info(`[poll] synced ${synced.length} workout(s): ${synced.map((r) => r.name).join(', ')}`);
      }
    } catch (err) {
      // Never let a poll failure take the server down — Tonal being briefly
      // unreachable must not stop the webhook from working.
      app.log.error({ err }, '[poll] sync check failed; will retry next interval');
    }
  };

  // unref so the interval never holds the process open during shutdown; the
  // listening socket is what keeps the server alive.
  setInterval(() => void tick(), everyMs).unref();
  app.log.info(
    `[poll] checking for new workouts every ${config.pollIntervalMinutes} minute(s), ` +
      `looking back ${config.pollLookback} activities`,
  );
  void tick(); // run once at startup to catch anything missed while down
}

async function main() {
  await service.init();
  await app.listen({ host: '0.0.0.0', port: config.port });
  startPolling();
}

main().catch((err) => {
  app.log.error(err);
  process.exit(1);
});
