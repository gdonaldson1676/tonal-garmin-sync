/**
 * Types describing the slices of the Tonal API we consume.
 *
 * Tonal has no public API and no published schema. `ts-tonal-client` wraps the
 * activity summaries and the movement catalog, but NOT the per-set detail
 * endpoint (`/users/{userId}/workout-activities/{activityId}`) that carries the
 * reps and weights — those shapes were established by inspecting live responses.
 *
 * Every field is optional and loose on purpose: Tonal can change this payload
 * without warning, and parsing must never hard-fail on an unexpected shape.
 * `normalizeWorkout()` in fit.ts handles the fallbacks. If Tonal does change
 * something, `npm run verify` prints the field names it actually sees against
 * your own account, so you can tell what moved.
 */

/** Aggregate summary from client.getActivitySummaries(). */
export interface TonalActivitySummaryLoose {
  id?: string;
  workoutActivityId?: string;
  workoutId?: string;
  name?: string;
  completed?: boolean;
  /**
   * "Internal" for workouts actually performed on the Tonal. Tonal's Apple Health
   * integration also imports outside activities (runs, rides) into the same feed
   * as "External" — those have no per-set detail and 404 if you ask for it.
   */
  activityType?: string;
  /** Set once an activity is deleted. Its detail endpoint 404s from then on. */
  deletedAt?: string | null;
  timestamp?: string;
  localTimestamp?: string;
  timeZone?: string;
  duration?: number; // seconds
  totalReps?: number;
  totalVolume?: number; // in TONAL_WEIGHT_UNIT
  totalWork?: number; // kJ
  timeUnderTension?: number;
  [key: string]: unknown;
}

/** One performed set inside the detail response (`workoutSetActivity[]`). */
export interface TonalSetActivityLoose {
  movementId?: string;
  /** actual reps performed — both `repetition` and `repCount` have been seen */
  repetition?: number;
  repCount?: number;
  repetitionTotal?: number;
  prescribedReps?: number;
  /** actual weight lifted, in TONAL_WEIGHT_UNIT — `baseWeight` is the one used */
  avgWeight?: number;
  baseWeight?: number;
  maxWeight?: number;
  volume?: number;
  oneRepMax?: number;
  blockNumber?: number;
  sideNumber?: number;
  /** actual per-set timing (the set's working time = time under tension) */
  beginTime?: string;
  endTime?: string;
  duration?: number; // seconds, == endTime - beginTime
  /** "Both" | "Left" | "Right" — used with the movement's two-sided flag */
  movementSide?: string;
  [key: string]: unknown;
}

/** Detail response from /users/{userId}/workout-activities/{activityId}. */
export interface TonalWorkoutDetailLoose {
  id?: string;
  name?: string;
  duration?: number; // seconds
  totalReps?: number;
  totalVolume?: number;
  percentCompleted?: number;
  timestamp?: string;
  startTime?: string;
  beginTime?: string;
  endTime?: string;
  /** the set array as Tonal actually names it */
  workoutSetActivity?: TonalSetActivityLoose[];
  /** tolerate alternative names seen in the wild */
  sets?: TonalSetActivityLoose[];
  setActivities?: TonalSetActivityLoose[];
  /** per-sample heart-rate time series + aggregates */
  workoutHeartRate?: {
    avgHeartRate?: number;
    minHeartRate?: number;
    maxHeartRate?: number;
    heartRateSource?: string;
    workoutHeartRateValues?: Array<{ timestamp?: string; heartRate?: number }>;
  };
  calories?: Array<{ caloriesBurned?: number }>;
  [key: string]: unknown;
}

/** Movement catalog entry from client.getMovements(). */
export interface TonalMovementLoose {
  id?: string;
  name?: string;
  isTwoSided?: boolean;
  isAlternating?: boolean;
  countReps?: boolean;
  [key: string]: unknown;
}

/** One performed set, as GET /sets returns it. Weights are in TONAL_WEIGHT_UNIT. */
export interface SetHistoryRow {
  activityId: string;
  /** workout's local date, YYYY-MM-DD */
  date: string;
  workout: string;
  exercise: string;
  /** set number within this movement */
  set?: number;
  side?: string;
  reps: number;
  weight?: number;
  volume?: number;
  oneRepMax?: number;
}

/** Our normalized representation, ready to encode into a FIT file. */
export interface NormalizedSet {
  index: number;
  exerciseName: string;
  movementId?: string;
  reps: number;
  weightKg: number;
  startTime: Date;
  durationSec: number;
  /** FIT exercise_category enum (camelCase), if mapped. */
  fitCategory?: string;
  /** FIT exercise_name numeric value within the category, if mapped. */
  fitSubtype?: number;
}

export interface NormalizedWorkout {
  activityId: string;
  name: string;
  startTime: Date;
  durationSec: number;
  totalReps: number;
  totalVolumeKg: number;
  sets: NormalizedSet[];
  /** heart-rate samples (chronological) + aggregates, if Tonal recorded them. */
  hrSamples: Array<{ time: Date; bpm: number }>;
  avgHr?: number;
  maxHr?: number;
  totalCalories?: number;
}
