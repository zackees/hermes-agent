/**
 * Linux GPU launch ledger (talos-hq/hermes-slim#6, NousResearch/hermes-agent#143056, #141753).
 *
 * The old NVIDIA/Mesa fallbacks kept a single-slot `booting` marker and read a
 * leftover one as "the GPU killed the last launch". Any pre-reveal exit left it
 * behind — a SIGKILL, a reboot, an unrelated crash, a second-instance launch —
 * and the sticky fallback it produced only expired on an app-version change,
 * which never happens for `0.0.0` (Nix/source/dev) builds. One stray kill pinned
 * the desktop to SwiftShader forever.
 *
 * The ledger is an append-only JSONL log of launch lifecycle events instead:
 *
 *   start            this launch began (records whether it probes hardware GL)
 *   revealed         the first window reached the screen — the GPU survived boot
 *   gpu-death        a GPU child died with a recovery-worthy reason (witnessed)
 *   second-instance  the launch lost the single-instance lock and exited
 *   clean-exit       the launch reached before-quit
 *
 * Each launch is classified from its events, and the fallback policy reads the
 * classification:
 *
 * - `healthy` (revealed, no GPU death) — force-killing it later changes nothing.
 * - `gpu-death` — witnessed evidence; engages software rendering.
 * - `aborted` — probed hardware GL, never revealed, never exited cleanly. One is
 *   noise (a kill, a reboot). Only BOOT_LOOP_ABORTS consecutive aborts, each
 *   started within BOOT_LOOP_WINDOW_MS of the next, read as a boot loop.
 * - `neutral` — second-instance, clean pre-reveal quit, or a software launch.
 *
 * Software rendering is never permanent: after REPROBE_BASE_LAUNCHES software
 * launches or REPROBE_BASE_MS since the evidence, the next launch re-probes
 * hardware GL. Each failed re-probe doubles both intervals (capped), so a truly
 * broken driver settles into CPU mode while a recovered host returns to the GPU.
 *
 * Pure decision logic plus thin fs helpers so it is unit-testable pre-ready.
 */

import fs from 'node:fs'
import path from 'node:path'

export const LINUX_GPU_LEDGER_FILENAME = 'gpu-launch-ledger.jsonl'

/** Consecutive pre-reveal hardware aborts that count as a boot loop. */
export const BOOT_LOOP_ABORTS = 3

/** Max gap between consecutive aborted starts for them to form one boot loop. */
export const BOOT_LOOP_WINDOW_MS = 10 * 60 * 1000

/** Software launches before the first hardware re-probe. */
export const REPROBE_BASE_LAUNCHES = 5

/** Wall time before the first hardware re-probe. */
export const REPROBE_BASE_MS = 24 * 60 * 60 * 1000

/** Backoff cap for repeated failed re-probes (2^4 = 16x the base). */
export const REPROBE_MAX_DOUBLINGS = 4

/** Entries kept when the ledger is compacted at launch. */
export const LEDGER_MAX_ENTRIES = 400

export type LedgerEventKind = 'start' | 'revealed' | 'gpu-death' | 'second-instance' | 'clean-exit'

export type GpuMode = 'hardware' | 'software'

export interface LedgerEvent {
  /** Epoch milliseconds. */
  t: number
  /** Launch id (unique per process). */
  launch: string
  ev: LedgerEventKind
  pid?: number
  /** start: how this launch renders. */
  mode?: GpuMode
  /** start: which ladder put it in software mode, if any. */
  ladder?: string
  app?: string
  driver?: string
  /** gpu-death: child-process-gone details. */
  reason?: string
  exitCode?: number | null
}

export type LaunchOutcome = 'healthy' | 'gpu-death' | 'aborted' | 'neutral'

export interface LaunchSummary {
  launch: string
  start: number
  mode: GpuMode
  outcome: LaunchOutcome
}

const EVENT_KINDS: ReadonlySet<string> = new Set(['start', 'revealed', 'gpu-death', 'second-instance', 'clean-exit'])

export function linuxGpuLedgerPath(userDataDir: string): string {
  return path.join(String(userDataDir || ''), LINUX_GPU_LEDGER_FILENAME)
}

export function parseLedger(text: string): LedgerEvent[] {
  const events: LedgerEvent[] = []

  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) {
      continue
    }

    try {
      const raw = JSON.parse(line) as Record<string, unknown>

      if (
        typeof raw.t === 'number' &&
        typeof raw.launch === 'string' &&
        typeof raw.ev === 'string' &&
        EVENT_KINDS.has(raw.ev)
      ) {
        events.push(raw as unknown as LedgerEvent)
      }
    } catch {
      // A torn final line from a killed process is expected; skip it.
    }
  }

  return events
}

export function readLedger(userDataDir: string, { readFileSync = fs.readFileSync } = {}): LedgerEvent[] {
  try {
    return parseLedger(readFileSync(linuxGpuLedgerPath(userDataDir), 'utf8'))
  } catch {
    return []
  }
}

/** One O_APPEND write per event: atomic for small lines, safe across instances. */
export function appendLedgerEvent(
  userDataDir: string,
  event: LedgerEvent,
  { appendFileSync = fs.appendFileSync, mkdirSync = fs.mkdirSync } = {}
): void {
  const dir = String(userDataDir || '')

  if (!dir) {
    return
  }

  mkdirSync(dir, { recursive: true })
  appendFileSync(linuxGpuLedgerPath(dir), `${JSON.stringify(event)}\n`, 'utf8')
}

/** Rewrite the ledger keeping only the newest entries. Best-effort. */
export function compactLedger(
  userDataDir: string,
  events: readonly LedgerEvent[],
  { writeFileSync = fs.writeFileSync, renameSync = fs.renameSync } = {}
): void {
  if (events.length <= LEDGER_MAX_ENTRIES) {
    return
  }

  const file = linuxGpuLedgerPath(userDataDir)
  const tmp = `${file}.${process.pid}.tmp`
  const kept = events.slice(-LEDGER_MAX_ENTRIES)

  writeFileSync(tmp, kept.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8')
  renameSync(tmp, file)
}

/** Group events into per-launch summaries, oldest first. */
export function summarizeLaunches(events: readonly LedgerEvent[]): LaunchSummary[] {
  const byLaunch = new Map<string, { start?: LedgerEvent; kinds: Set<LedgerEventKind> }>()

  for (const event of events) {
    let entry = byLaunch.get(event.launch)

    if (!entry) {
      entry = { kinds: new Set() }
      byLaunch.set(event.launch, entry)
    }

    entry.kinds.add(event.ev)

    if (event.ev === 'start' && !entry.start) {
      entry.start = event
    }
  }

  const launches: LaunchSummary[] = []

  for (const [launch, { start, kinds }] of byLaunch) {
    if (!start) {
      continue
    }

    const mode: GpuMode = start.mode === 'software' ? 'software' : 'hardware'
    let outcome: LaunchOutcome

    if (kinds.has('gpu-death') && mode === 'hardware') {
      outcome = 'gpu-death'
    } else if (kinds.has('revealed')) {
      outcome = 'healthy'
    } else if (kinds.has('second-instance') || kinds.has('clean-exit') || mode === 'software') {
      outcome = 'neutral'
    } else {
      outcome = 'aborted'
    }

    launches.push({ launch, start: start.t, mode, outcome })
  }

  return launches.sort((a, b) => a.start - b.start)
}

export interface LedgerGpuDecision {
  software: boolean
  reason: string | null
}

/**
 * Whether this launch should start in software mode, from prior launches only.
 *
 * Walks back from the newest launch to the most recent healthy hardware boot
 * (the last proof the GPU works). Within that tail:
 * - no evidence → hardware;
 * - evidence (a GPU death, or a rapid BOOT_LOOP_ABORTS abort streak) → software,
 *   until the re-probe interval — launches or wall time since the newest
 *   evidence, doubled per failed re-probe — elapses, then hardware once.
 */
export function decideFromLedger(launches: readonly LaunchSummary[], now: number): LedgerGpuDecision {
  let tailStart = 0

  for (let i = launches.length - 1; i >= 0; i -= 1) {
    if (launches[i].mode === 'hardware' && launches[i].outcome === 'healthy') {
      tailStart = i + 1

      break
    }
  }

  const tail = launches.slice(tailStart)

  // Evidence episodes: each witnessed death, and each rapid abort streak.
  const evidenceIdx: number[] = []
  let streak: number[] = []

  const flushStreak = () => {
    if (streak.length >= BOOT_LOOP_ABORTS) {
      evidenceIdx.push(streak[streak.length - 1])
    }

    streak = []
  }

  tail.forEach((launch, i) => {
    if (launch.mode !== 'hardware') {
      return
    }

    if (launch.outcome === 'gpu-death') {
      flushStreak()
      evidenceIdx.push(i)

      return
    }

    if (launch.outcome === 'aborted') {
      const prev = streak.length ? tail[streak[streak.length - 1]] : null

      if (prev && launch.start - prev.start > BOOT_LOOP_WINDOW_MS) {
        flushStreak()
      }

      streak.push(i)

      return
    }

    // neutral hardware launches (second instance, clean pre-reveal quit) break no streak
  })

  flushStreak()

  if (!evidenceIdx.length) {
    return { software: false, reason: null }
  }

  const last = evidenceIdx[evidenceIdx.length - 1]
  const failedReprobes = Math.min(evidenceIdx.length - 1, REPROBE_MAX_DOUBLINGS)
  const factor = 2 ** failedReprobes
  const softwareSince = tail.slice(last + 1).filter(l => l.mode === 'software').length
  const elapsed = now - tail[last].start
  const kind = tail[last].outcome === 'gpu-death' ? 'witnessed GPU-process death' : 'pre-reveal boot loop'

  if (softwareSince >= REPROBE_BASE_LAUNCHES * factor || elapsed >= REPROBE_BASE_MS * factor) {
    return { software: false, reason: `re-probing hardware GL after ${kind} (${softwareSince} software launches)` }
  }

  return {
    software: true,
    reason: `${kind}; re-probe after ${REPROBE_BASE_LAUNCHES * factor - softwareSince} more launches`
  }
}

/** Process-wide recorder: one launch id, best-effort appends. */
export function createLaunchRecorder(userDataDir: string, { now = Date.now, pid = process.pid } = {}) {
  const launch = `${now().toString(36)}-${pid}-${Math.random().toString(36).slice(2, 8)}`
  const seen = new Set<LedgerEventKind>()

  const record = (ev: LedgerEventKind, extra: Partial<LedgerEvent> = {}) => {
    // revealed/clean-exit/second-instance are once-per-launch facts.
    if (ev !== 'gpu-death' && seen.has(ev)) {
      return
    }

    seen.add(ev)

    try {
      appendLedgerEvent(userDataDir, { t: now(), launch, ev, pid, ...extra })
    } catch {
      void 0
    }
  }

  return { launch, record }
}
