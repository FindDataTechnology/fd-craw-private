import schedule from "node-schedule";
import cronParser from "cron-parser";
import fs from "node:fs";
import path from "node:path";
import { storeDir } from "./paths.js";
import { atomicWriteJson, readJsonOr, createWriteChain } from "./lib/persistence.js";

const CRON_STORAGE_DIR = storeDir("cron-store", process.env.CRON_STORAGE_PATH);
const JOBS_FILE = path.join(CRON_STORAGE_DIR, "jobs.json");

// Missed-occurrence accounting caps iteration at this many gaps per load so a
// job left dead for years cannot spin the parser.
const MAX_MISSED_PER_LOAD = 100;
const TURN_TIMEOUT_MS = 10 * 60 * 1000;

let jobs = new Map(); // id -> job data (loaded from disk + live job
let broadcastFn = null;
let runJobTurnFn = null;
let isBusyFn = null;
let executionQueue = Promise.resolve();

// ── Initialization ────────────────────────────────────────────────────────────

async function initCron({ broadcast, runJobTurn, isBusy }) {
  broadcastFn = broadcast;
  runJobTurnFn = runJobTurn;
  isBusyFn = isBusy;

  // Ensure storage directory exists
  await fs.promises.mkdir(CRON_STORAGE_DIR, { recursive: true });

  // Load persisted jobs
  await loadJobs();
}

// ── Persistence ─────────────────────────────────────────────────────────────

function loadJobs() {
  const savedJobs = readJsonOr(JOBS_FILE, [], { label: "cron" });
  if (!Array.isArray(savedJobs)) return;
  let dirty = false;
  for (const jobData of savedJobs) {
    const j = { missed: 0, ...jobData };
    if (!j.sessionId) {
      // Backfill: mint the dedicated session id legacy records never had, so
      // the binding is stable across restarts from the first reload on.
      j.sessionId = `cron-${j.id}`;
      dirty = true;
    }
    if (j.type === "recurring" && j.cron) {
      // Downtime accounting happens before rescheduling: occurrences entirely
      // covered by the downtime window are recorded as missed, never replayed.
      if (countMissedOccurrences(j)) dirty = true;
      scheduleJob(j);
    } else if (j.type === "once" && !j.paused) {
      const scheduledAt = new Date(j.when);
      if (scheduledAt > new Date()) {
        scheduleJob(j);
      } else {
        // One-shot jobs that passed their scheduled time while down are marked
        // expired; they stay in history only.
        j.status = "expired";
        dirty = true;
      }
    }
    jobs.set(j.id, { ...j, job: null });
  }
  console.log(`[cron] Loaded ${jobs.size} jobs from storage`);
  // Load-time mutations (missed markers, expired status, backfilled ids) must
  // reach disk or the next restart re-counts the same downtime gap.
  if (dirty) void saveJobs();
}

// Serialized + atomic persistence: mutations rewrite the whole jobs file, so
// overlapping saves are queued (no lost update) and each write goes through a
// unique temp file (no interleaved-write corruption — the pre-fix race two
// concurrent mutations could trigger on the shared jobs.json.tmp).
const writeChain = createWriteChain();
function saveJobs() {
  return writeChain.mutate(async () => {
    // Serialize only the job data (excluding the live scheduleJob object).
    // Computed inside the queued task so a later save always sees the
    // latest in-memory state.
    const serializable = [...jobs.values()].map((j) => ({
      id: j.id,
      type: j.type,
      cron: j.cron,
      when: j.when,
      prompt: j.prompt,
      preset: j.preset ?? null,
      sessionId: j.sessionId ?? null,
      sessionTitle: j.sessionTitle ?? null,
      tz: j.tz ?? null,
      status: j.status,
      paused: j.paused,
      createdAt: j.createdAt,
      lastRun: j.lastRun,
      nextRun: j.nextRun,
      missed: j.missed ?? 0,
      history: j.history,
    }));
    await atomicWriteJson(JOBS_FILE, serializable);
  });
}

// ── Schedule math ────────────────────────────────────────────────────────────

// cron-parser is node-schedule's own expression parser, so occurrence math
// here always agrees with what the timer fires on.
function parseRule(cron, tz) {
  return cronParser.parseExpression(cron, { tz: tz || undefined });
}

function validateCron(cron, tz) {
  if (!cron || typeof cron !== "string") return "cron expression is required";
  try {
    parseRule(cron, tz);
    return null;
  } catch {
    return `invalid cron expression: ${cron}`;
  }
}

// Count occurrences strictly between lastRun and now for a recurring job that
// was NOT running (load-time gap). Increments the missed counter and appends a
// history marker so the UI can show why a job skipped. Returns true when the
// record changed (caller persists).
function countMissedOccurrences(job) {
  const now = new Date();
  const from = job.lastRun ? new Date(job.lastRun) : null;
  if (!from || Number.isNaN(from.getTime())) return false;
  try {
    const iter = parseRule(job.cron, job.tz);
    let missed = 0;
    // prev() yields occurrences strictly before `now`; each one after lastRun
    // was entirely covered by downtime. No warm-up call — the first prev() is
    // itself a countable occurrence.
    let prev = iter.prev();
    while (prev && prev.toDate() > from && missed < MAX_MISSED_PER_LOAD) {
      missed++;
      prev = iter.prev();
    }
    if (missed > 0) {
      job.missed = (job.missed || 0) + missed;
      job.history = job.history || [];
      job.history.push({ time: now.toISOString(), missed, success: null });
      console.log(`[cron] Job ${job.id} missed ${missed} occurrence(s) during downtime`);
      return true;
    }
  } catch (err) {
    console.warn(`[cron] missed-count failed for ${job.id}: ${err.message}`);
  }
  return false;
}

// ── Job Management ──────────────────────────────────────────────────────────

function generateId() {
  return `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function scheduleJob(jobData) {
  const j = { ...jobData };
  if (j.paused) return j;
  try {
    // tz, when present, evaluates the cron rule in the job's IANA timezone
    // (verified: node-schedule honors { rule, tz }); absent = cell-local,
    // which is the pre-change behavior legacy jobs keep.
    const spec = j.type === "recurring" && j.cron
      ? (j.tz ? { rule: j.cron, tz: j.tz } : j.cron)
      : new Date(j.when);
    const job = schedule.scheduleJob(spec, async () => {
      await executeJob(j.id);
    });
    j.job = job;
    // Update nextRun time
    if (job?.nextInvocation()) {
      j.nextRun = job.nextInvocation().toISOString();
    }
  } catch (err) {
    console.error(`[cron] Failed to schedule job ${j.id}:`, err.message);
    j.status = "error";
    j.error = err.message;
  }
  return j;
}

async function addJob({ cron, when, prompt, preset, tz, sessionTitle }) {
  if (cron) {
    const invalid = validateCron(cron, tz);
    if (invalid) throw new Error(invalid);
  } else if (!when || Number.isNaN(new Date(when).getTime())) {
    throw new Error("a valid cron expression or one-shot time is required");
  }
  if (!prompt || typeof prompt !== "string") throw new Error("prompt is required");

  const id = generateId();
  const type = cron ? "recurring" : "once";
  const jobData = {
    id,
    type,
    cron,
    when,
    prompt,
    // Binding: the preset the job runs under and the session its output
    // belongs to. sessionId is minted here so the id is stable from creation,
    // but the dsh/SQLite session itself is only created at first execution
    // (a paused or deleted job leaves no orphan session behind).
    preset: preset ?? null,
    sessionId: `cron-${id}`,
    sessionTitle: sessionTitle || null,
    tz: tz || null,
    status: "scheduled",
    paused: false,
    createdAt: new Date().toISOString(),
    lastRun: null,
    nextRun: null,
    missed: 0,
    history: [],
  };

  const scheduled = scheduleJob(jobData);
  jobs.set(id, scheduled);
  await saveJobs();
  broadcastJobStatus(id);
  // Return the client-facing shape, never the live record: it carries the
  // node-schedule Job handle (a circular object), and the WS reply serializes
  // this value. Same stripping listJobs/getJob already apply.
  return getJob(id);
}

async function removeJob(id) {
  const job = jobs.get(id);
  if (!job) return false;
  if (job.job) {
    job.job.cancel();
  }
  jobs.delete(id);
  await saveJobs();
  broadcastFn({ type: "cron_removed", id });
  return true;
}

async function pauseJob(id) {
  const job = jobs.get(id);
  if (!job) return false;
  if (job.job) {
    job.job.cancel();
    job.job = null;
  }
  job.paused = true;
  job.status = "paused";
  await saveJobs();
  broadcastJobStatus(id);
  return true;
}

async function resumeJob(id) {
  const job = jobs.get(id);
  if (!job || !job.paused) return false;
  job.paused = false;
  job.status = "scheduled";
  // Reschedule
  if (job.type === "recurring" && job.cron) {
    countMissedOccurrences(job);
    const scheduled = scheduleJob(job);
    jobs.set(id, scheduled);
  } else if (job.type === "once" && job.when) {
    const scheduledAt = new Date(job.when);
    if (scheduledAt > new Date()) {
      const scheduled = scheduleJob(job);
      jobs.set(id, scheduled);
    } else {
      job.status = "expired";
    }
  }
  await saveJobs();
  broadcastJobStatus(id);
  return true;
}

function clientShape(j) {
  return {
    id: j.id,
    type: j.type,
    cron: j.cron,
    when: j.when,
    prompt: j.prompt,
    preset: j.preset ?? null,
    sessionId: j.sessionId ?? null,
    sessionTitle: j.sessionTitle ?? null,
    tz: j.tz ?? null,
    status: j.status,
    paused: j.paused,
    createdAt: j.createdAt,
    lastRun: j.lastRun,
    nextRun: j.nextRun,
    missed: j.missed ?? 0,
    history: j.history.slice(-20), // Last 20 executions
  };
}

function listJobs() {
  return [...jobs.values()].map(clientShape);
}

function getJob(id) {
  const j = jobs.get(id);
  return j ? clientShape(j) : null;
}

// ── Execution ────────────────────────────────────────────────────────────────────

async function executeJob(id) {
  // Queue execution to prevent concurrent runs
  executionQueue = executionQueue.then(async () => {
    const job = jobs.get(id);
    if (!job || job.paused || job.status === "expired" || job.status === "completed") return;

    const startTime = new Date().toISOString();
    broadcastFn({ type: "cron_fired", id, prompt: job.prompt, startTime });

    try {
      job.lastRun = startTime;
      job.status = "running";
      broadcastJobStatus(id);

      // The host owns the turn: it waits for the live session to go idle,
      // switches the runtime to the job's preset, prompts the bound session,
      // and records the exchange under it.
      const result = await runJobTurnFn(job, { turnTimeoutMs: TURN_TIMEOUT_MS });

      const historyEntry = {
          time: startTime,
          duration: Date.now() - new Date(startTime).getTime(),
          success: result?.ok !== false,
          ...(result?.error ? { error: result.error } : {}),
        };
        job.history.push(historyEntry);
        job.status = job.type === "once" ? "completed" : "scheduled";

        // Prune history to keep last 100 entries
        if (job.history.length > 100) {
          job.history = job.history.slice(-100);
        }

        // Update nextRun for recurring jobs
        if (job.job && job.job.nextInvocation()) {
          job.nextRun = job.job.nextInvocation().toISOString();
        }

        await saveJobs();
        broadcastFn({
          type: "cron_completed",
          id,
          success: result?.ok !== false,
          ...(result?.error ? { error: result.error } : {}),
          completedAt: new Date().toISOString(),
        });
    } catch (err) {
      const historyEntry = {
        time: startTime,
        duration: Date.now() - new Date(startTime).getTime(),
        success: false,
        error: err.message,
      };
      job.history.push(historyEntry);
      job.status = job.type === "once" ? "completed" : "scheduled";
      await saveJobs();
      broadcastFn({
        type: "cron_completed",
        id,
        success: false,
        error: err.message,
        completedAt: new Date().toISOString(),
      });
    }
  });
  await executionQueue;
}

// Run a job immediately (bypasses schedule). Enqueues only — the WS ack
// (cron_run_started) must not wait out the whole turn; completion arrives as
// the cron_completed broadcast.
async function runJobNow(id) {
  const job = jobs.get(id);
  if (!job) return false;
  void executeJob(id);
  return true;
}

// ── Broadcasting ─────────────────────────────────────────────────────────────

function broadcastJobStatus(id) {
  const job = getJob(id);
  if (job && broadcastFn) {
    broadcastFn({ type: "cron_status", job });
  }
}

// Get dashboard state snapshot
function getDashboardState() {
  return {
    jobs: listJobs(),
    activeTasks: [], // Tracked in server.js
    recentActivity: getRecentActivity(),
    agentStatus: {
      isBusy: isBusyFn ? isBusyFn() : false,
    },
  };
}

function getRecentActivity() {
  // Collect recent activity from all jobs
  const activities = [];
  for (const job of jobs.values()) {
    for (const h of job.history.slice(-5)) {
      activities.push({
        type: "cron_execution",
        jobId: job.id,
        prompt: job.prompt,
        time: h.time,
        success: h.success,
      });
    }
  }
  // Sort by time, newest first, limit to 50
  return activities.sort((a, b) => new Date(b.time) - new Date(a.time)).slice(0, 50);
}

// ── Graceful Shutdown ────────────────────────────────────────────────────────

function shutdown() {
  for (const job of jobs.values()) {
    if (job.job) {
      job.job.cancel();
    }
  }
  schedule.gracefulShutdown();
}

export {
  initCron,
  addJob,
  removeJob,
  pauseJob,
  resumeJob,
  listJobs,
  getJob,
  runJobNow,
  getDashboardState,
  validateCron,
  shutdown,
};
