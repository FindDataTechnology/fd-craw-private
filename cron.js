import schedule from "node-schedule";
import fs from "node:fs";
import path from "node:path";
import { storeDir } from "./paths.js";
import { atomicWriteJson, readJsonOr, createWriteChain } from "./lib/persistence.js";

const CRON_STORAGE_DIR = storeDir("cron-store", process.env.CRON_STORAGE_PATH);
const JOBS_FILE = path.join(CRON_STORAGE_DIR, "jobs.json");

let jobs = new Map(); // id -> job data (loaded from disk + live job
let broadcastFn = null;
let sessionPromptFn = null;
let isStreamingFn = null;
let executionQueue = Promise.resolve();

// ── Initialization ────────────────────────────────────────────────────────────

async function initCron({ broadcast, sessionPrompt, isStreaming }) {
  broadcastFn = broadcast;
  sessionPromptFn = sessionPrompt;
  isStreamingFn = isStreaming;

  // Ensure storage directory exists
  await fs.promises.mkdir(CRON_STORAGE_DIR, { recursive: true });

  // Load persisted jobs
  await loadJobs();
}

// ── Persistence ─────────────────────────────────────────────────────────────

function loadJobs() {
  const savedJobs = readJsonOr(JOBS_FILE, [], { label: "cron" });
  if (!Array.isArray(savedJobs)) return;
  for (const jobData of savedJobs) {
    // Reschedule recurring jobs
    if (jobData.type === "recurring" && jobData.cron) {
      scheduleJob(jobData);
    }
    // One-shot jobs that passed their scheduled time are not rescheduled;
    // they stay in history only.
    jobs.set(jobData.id, { ...jobData, job: null });
  }
  console.log(`[cron] Loaded ${jobs.size} jobs from storage`);
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
      prompt: j.prompt,
      when: j.when,
      status: j.status,
      paused: j.paused,
      createdAt: j.createdAt,
      lastRun: j.lastRun,
      nextRun: j.nextRun,
      history: j.history,
    }));
    await atomicWriteJson(JOBS_FILE, serializable);
  });
}

// ── Job Management ──────────────────────────────────────────────────────────

function generateId() {
  return `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function scheduleJob(jobData) {
  const j = { ...jobData };
  if (j.paused) return;
  try {
    const job = schedule.scheduleJob(j.cron || new Date(j.when), async () => {
      await executeJob(j.id);
    });
    j.job = job;
    // Update nextRun time
    if (job.nextInvocation()) {
      j.nextRun = job.nextInvocation().toISOString();
    }
  } catch (err) {
    console.error(`[cron] Failed to schedule job ${j.id}:`, err.message);
    j.status = "error";
    j.error = err.message;
  }
  return j;
}

async function addJob({ cron, when, prompt }) {
  const id = generateId();
  const type = cron ? "recurring" : "one-shot";
  const jobData = {
    id,
    type,
    cron,
    when,
    prompt,
    status: "scheduled",
    paused: false,
    createdAt: new Date().toISOString(),
    lastRun: null,
    nextRun: null,
    history: [],
  };

  const scheduled = scheduleJob(jobData);
  jobs.set(id, scheduled);
  await saveJobs();
  broadcastJobStatus(id);
  return scheduled;
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
    const scheduled = scheduleJob(job);
    jobs.set(id, scheduled);
  } else if (job.type === "one-shot" && job.when) {
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

function listJobs() {
  return [...jobs.values()].map((j) => ({
    id: j.id,
    type: j.type,
    cron: j.cron,
    when: j.when,
    prompt: j.prompt,
    status: j.status,
    paused: j.paused,
    createdAt: j.createdAt,
    lastRun: j.lastRun,
    nextRun: j.nextRun,
    history: j.history.slice(-20), // Last 20 executions
  }));
}

function getJob(id) {
  const j = jobs.get(id);
  if (!j) return null;
  return {
    id: j.id,
    type: j.type,
    cron: j.cron,
    when: j.when,
    prompt: j.prompt,
    status: j.status,
    paused: j.paused,
    createdAt: j.createdAt,
    lastRun: j.lastRun,
    nextRun: j.nextRun,
    history: j.history.slice(-20),
  };
}

// ── Execution ────────────────────────────────────────────────────────────────────

async function executeJob(id) {
  // Queue execution to prevent concurrent runs
  executionQueue = executionQueue.then(async () => {
    const job = jobs.get(id);
    if (!job || job.paused) return;

    // Skip if agent is currently streaming
    if (isStreamingFn && isStreamingFn()) {
      console.log(`[cron] Skipping job ${id} - agent is busy`);
      return;
    }

    const startTime = new Date().toISOString();
    broadcastFn({ type: "cron_fired", id, prompt: job.prompt, startTime });

    try {
      job.lastRun = startTime;
      job.status = "running";
      broadcastJobStatus(id);

      // Execute the prompt via the agent session
      if (sessionPromptFn) {
        await sessionPromptFn(job.prompt);
      }

      const historyEntry = {
          time: startTime,
          duration: Date.now() - new Date(startTime).getTime(),
          success: true,
        };
        job.history.push(historyEntry);
        job.status = job.type === "one-shot" ? "completed" : "scheduled";

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
          success: true,
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
      job.status = job.type === "one-shot" ? "completed" : "scheduled";
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

// Run a job immediately (bypasses schedule)
async function runJobNow(id) {
  const job = jobs.get(id);
  if (!job) return false;
  await executeJob(id);
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
      isStreaming: isStreamingFn ? isStreamingFn() : false,
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
  shutdown,
};
