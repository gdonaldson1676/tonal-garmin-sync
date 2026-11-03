import TonalClient from '@dlwiest/ts-tonal-client';
import type {
  TonalActivitySummaryLoose,
  TonalMovementLoose,
  TonalWorkoutDetailLoose,
} from './types.js';

/**
 * Wrapper around ts-tonal-client.
 *
 * The library wraps activity summaries and the movement catalog, but NOT the
 * per-set detail endpoint we need (`/users/{userId}/workout-activities/{id}`).
 * Its internal `httpClient.request(endpoint, options)` accepts an arbitrary path
 * and already handles bearer auth + token refresh + retries, so we reuse it for
 * the raw call. `httpClient`/`authManager` are declared private in the library,
 * so we reach them through a single, clearly-marked runtime access point
 * (`rawRequest`). If a library upgrade changes these internals, only that one
 * method needs adjusting.
 */

interface InternalHttpClient {
  request<T>(endpoint: string, options?: Record<string, unknown>, expectsBody?: boolean): Promise<T>;
}

export class Tonal {
  private constructor(
    private readonly client: TonalClient,
    private readonly userId: string,
  ) {}

  static async connect(username: string, password: string): Promise<Tonal> {
    const client = await TonalClient.create({ username, password });
    const info = (await client.getUserInfo()) as unknown as Record<string, unknown>;
    const userId = String(info.id ?? info.userId ?? '');
    if (!userId) {
      throw new Error('Could not determine Tonal userId from getUserInfo()');
    }
    return new Tonal(client, userId);
  }

  /** Reach the library's internal authenticated HTTP client. See class doc. */
  private rawRequest<T>(endpoint: string, headers?: Record<string, string>): Promise<T> {
    const http = (this.client as unknown as { httpClient: InternalHttpClient }).httpClient;
    if (!http || typeof http.request !== 'function') {
      throw new Error(
        'ts-tonal-client internal httpClient is unavailable — the library layout changed; update Tonal.rawRequest().',
      );
    }
    return http.request<T>(endpoint, { method: 'GET', ...(headers ? { headers } : {}) });
  }

  /** The latest 50 activity summaries — Tonal's default page. */
  async getActivitySummaries(): Promise<TonalActivitySummaryLoose[]> {
    return (await this.client.getActivitySummaries()) as unknown as TonalActivitySummaryLoose[];
  }

  /**
   * Every activity summary, ever. Tonal pages this endpoint with the request
   * headers `pg-offset` / `pg-limit` (query parameters are ignored), which the
   * library doesn't expose.
   */
  async getAllActivitySummaries(): Promise<TonalActivitySummaryLoose[]> {
    const pageSize = 200;
    const all: TonalActivitySummaryLoose[] = [];
    for (let offset = 0; ; offset += pageSize) {
      const page = await this.rawRequest<TonalActivitySummaryLoose[]>(
        `/users/${this.userId}/activity-summaries`,
        { 'pg-offset': String(offset), 'pg-limit': String(pageSize) },
      );
      all.push(...page);
      if (page.length < pageSize) return all;
    }
  }

  async getMovements(): Promise<TonalMovementLoose[]> {
    return (await this.client.getMovements()) as unknown as TonalMovementLoose[];
  }

  /** Raw GET of the per-set detail for a completed workout activity. */
  async getWorkoutDetail(activityId: string): Promise<TonalWorkoutDetailLoose> {
    return this.rawRequest<TonalWorkoutDetailLoose>(
      `/users/${this.userId}/workout-activities/${activityId}`,
    );
  }

  /**
   * The last `count` *completed, syncable* activity summaries, oldest first.
   *
   * Oldest-first matters: when a single pass syncs several workouts, they should
   * reach Garmin in the order they actually happened.
   *
   * Activities without per-set detail are filtered out here rather than left to
   * fail later — see `isSyncable`.
   */
  async getRecentCompletedActivities(count: number): Promise<TonalActivitySummaryLoose[]> {
    const summaries = await this.getActivitySummaries();
    return summaries
      .filter((s) => s.completed !== false && isSyncable(s))
      .sort((a, b) => tsOf(a) - tsOf(b))
      .slice(-Math.max(1, count));
  }

  /**
   * Most recent *completed* activity summary, by timestamp.
   * Returns undefined if there are no completed activities.
   */
  async getLatestCompletedActivity(): Promise<TonalActivitySummaryLoose | undefined> {
    const recent = await this.getRecentCompletedActivities(1);
    return recent[recent.length - 1];
  }
}

/**
 * Whether an activity is one we can actually fetch per-set detail for.
 *
 * Two kinds of entry in the feed look completed but have no workout behind them,
 * and 404 on the detail endpoint:
 *
 *  - **External activities.** Tonal's Apple Health integration imports outside
 *    workouts (runs, rides) into the same feed, marked `activityType: "External"`.
 *  - **Deleted activities**, which keep appearing with `deletedAt` set.
 *
 * A missing `activityType` counts as syncable: the field is only meaningful when
 * present, and treating absence as "skip" would silently sync nothing at all if
 * Tonal ever stopped sending it.
 */
export function isSyncable(summary: TonalActivitySummaryLoose): boolean {
  if (summary.deletedAt) return false;
  return summary.activityType === undefined || summary.activityType === 'Internal';
}

/** True for a Tonal API error carrying the given HTTP status. */
export function isHttpStatus(err: unknown, status: number): boolean {
  return typeof err === 'object' && err !== null && (err as { statusCode?: unknown }).statusCode === status;
}

/**
 * Whether an error means "this session is no longer usable", as opposed to
 * "this one request failed". Only the former justifies throwing the cached
 * client away and logging in again.
 */
export function isAuthFailure(err: unknown): boolean {
  if (isHttpStatus(err, 401) || isHttpStatus(err, 403)) return true;
  const msg = err instanceof Error ? err.message.toLowerCase() : '';
  return msg.includes('authenticate') || msg.includes('token expired');
}

/**
 * The id used by the detail endpoint: prefer an explicit activity id, falling
 * back through the other field names seen in the wild.
 */
export function activityIdOf(summary: TonalActivitySummaryLoose): string {
  const id = summary.id ?? summary.workoutActivityId ?? summary.workoutId;
  if (!id) {
    throw new Error('Activity summary has no usable id field');
  }
  return String(id);
}

function tsOf(s: TonalActivitySummaryLoose): number {
  const t = s.timestamp ?? s.localTimestamp;
  const n = t ? Date.parse(t) : NaN;
  return Number.isNaN(n) ? 0 : n;
}
