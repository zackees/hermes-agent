/**
 * Linux GPU-child software fallback for #124843.
 *
 * On Mesa/Wayland (Intel iGPU, no NVIDIA driver) the Chromium GPU child can
 * fail initialization (`GPU process launch failed: error_code=1002`) and —
 * instead of crashing — retry inside a sub-zygote forever: ~20 spinning
 * threads, repeated `/dev/dri/renderD128` opens, no `--type=gpu-process`,
 * ~350% CPU from launch with no recovery. Chromium never surfaces a fatal,
 * so the app must bound the retry itself: one relaunch into software
 * rendering, recorded in the launch ledger so later boots go straight to
 * software until the ledger's backoff re-probes the GPU.
 *
 * Deliberately reactive, not proactive: a healthy Mesa/Wayland stack (Brave
 * renders the same node at ~1% CPU) keeps full acceleration. The fallback
 * engages only on a witnessed GPU launch failure/crash or a rapid pre-reveal
 * boot loop recorded in the launch ledger.
 *
 * Skipped when software rendering is already on (remote-display path,
 * NVIDIA SwiftShader path, `HERMES_DESKTOP_DISABLE_GPU=1`, `--disable-gpu`),
 * and never when `HERMES_DESKTOP_DISABLE_GPU=0` keeps the GPU on.
 *
 * Pure + dependency-free so it can be unit-tested and called before app ready.
 * `--disable-gpu` argv helpers are reused from windows-stack-cookie-fallback
 * (one spelling per concept) — they are platform-agnostic despite the name.
 */

import fs from 'node:fs'
import path from 'node:path'

import type { LedgerGpuDecision } from './linux-gpu-launch-ledger'
import { alreadyHasDisableGpu, isHermesDesktopGpuOverrideOff } from './windows-stack-cookie-fallback'

/** Legacy single-slot marker, superseded by the launch ledger; deleted at launch. */
export const LINUX_GPU_FALLBACK_MARKER_FILENAME = 'linux-gpu-fallback.json'

export function linuxGpuMarkerPath(userDataDir: string): string {
  return path.join(String(userDataDir || ''), LINUX_GPU_FALLBACK_MARKER_FILENAME)
}

/** Remove the legacy marker: its sticky `fallback` never expired on `0.0.0` builds. */
export function removeLegacyLinuxGpuMarker(userDataDir: string, { rmSync = fs.rmSync } = {}): void {
  try {
    rmSync(linuxGpuMarkerPath(userDataDir), { force: true })
  } catch {
    void 0
  }
}

/**
 * Seconds after the main window reveals before the #124843 silent-retry check
 * looks for a GPU child: long enough that a healthy host's GPU child exists,
 * short enough that a sub-zygote spinning at ~350% CPU gets bounded fast.
 */
export const LINUX_GPU_SILENT_RETRY_GRACE_S = 30

/** `child-process-gone` reasons that witness a broken GPU child. */
const GPU_FAILURE_REASONS = new Set(['crashed', 'launch-failure'])

export interface LinuxGpuLaunchDecision {
  enable: boolean
  reason: string | null
}

/**
 * Single launch-time decision: whether this Linux launch disables GPU
 * hardware acceleration. Cross-launch evidence (witnessed GPU-child deaths,
 * rapid pre-reveal boot loops, re-probe backoff) comes from the launch ledger
 * — see linux-gpu-launch-ledger.ts and talos-hq/hermes-slim#6.
 */
export function decideLinuxGpuLaunch(
  options: {
    platform?: NodeJS.Platform | string
    argv?: readonly string[]
    env?: NodeJS.ProcessEnv
    ledger?: LedgerGpuDecision | null
    remoteDisplayReason?: string | null
    nvidiaFallbackActive?: boolean
  } = {}
): LinuxGpuLaunchDecision {
  const off: LinuxGpuLaunchDecision = { enable: false, reason: null }

  if ((options.platform ?? process.platform) !== 'linux') {
    return off
  }

  const argv = options.argv ?? process.argv
  const env = options.env ?? process.env

  // A user who forced GPU back on owns that call — even over ledger evidence.
  if (isHermesDesktopGpuOverrideOff(env)) {
    return off
  }

  if (alreadyHasDisableGpu(argv, env)) {
    return { enable: true, reason: 'already-enabled' }
  }

  // The remote-display and NVIDIA paths already force software rendering;
  // don't pile a second fallback on top of theirs.
  if (options.remoteDisplayReason || options.nvidiaFallbackActive) {
    return off
  }

  if (options.ledger?.software) {
    return { enable: true, reason: options.ledger.reason }
  }

  return off
}

/**
 * True when a Linux GPU child died with launch-failure/crash evidence and we
 * should one-shot relaunch with `--disable-gpu` before Chromium's retry loop
 * burns the machine (#124843). Bounded: once per process (caller tracks
 * `relaunchAttempted`), sticky across boots via the marker the caller writes.
 */
export function shouldRelaunchForLinuxGpuCrash(options: {
  platform?: NodeJS.Platform | string
  details?: { type?: string; reason?: string } | null
  alreadySoftware?: boolean
  relaunchAttempted?: boolean
}): boolean {
  if ((options.platform ?? process.platform) !== 'linux') {
    return false
  }

  if (options.alreadySoftware || options.relaunchAttempted) {
    return false
  }

  const type = String(options.details?.type || '').toLowerCase()

  if (type !== 'gpu') {
    return false
  }

  return GPU_FAILURE_REASONS.has(String(options.details?.reason || '').toLowerCase())
}

/**
 * Exit status Chromium uses to SIGTERM its GPU process when it never became
 * usable (#121954): the sandbox-blocked GPU child dies pre-main on an
 * FD-ownership violation and the browser prints "GPU process isn't usable.
 * Goodbye." before SIGTERMing it. Node reports signal deaths as `null`
 * exitCode + `signalName: 'SIGTERM'`; Electron serializes that as 143.
 */
export const GPU_CHILD_SANDBOX_SIGTERM_EXIT = 143

export type LinuxGpuDeathPath = 'no-sandbox' | 'disable-gpu' | null

/**
 * Coalesced recovery decision for one Linux GPU-child death (#86073, #124843,
 * #121954). One death produces exactly one bounded relaunch:
 *
 * - The sandbox signature (SIGTERM/143, #121954) is tried FIRST: that host
 *   matrix shows `--disable-gpu` still crashes, so software fallback would
 *   waste the one shot. `alreadyNoSandbox` covers a sticky/relaunched
 *   `--no-sandbox` boot, `sandboxRelaunchAttempted` the one-shot guard.
 * - Any other GPU failure reason (crashed / launch-failure, #124843) falls to
 *   the software ladder — including the RELAPSE after a `--no-sandbox`
 *   relaunch died again: that second death proves the sandbox was not the
 *   (only) problem, so the next bounded step is `--disable-gpu`.
 * - null when the death matches neither ladder or both are spent/already on.
 *
 * Pure so tests never boot Electron; the caller owns the relaunch flags.
 */
export function linuxGpuChildDeathPath(options: {
  platform?: NodeJS.Platform | string
  details?: { type?: string; reason?: string; exitCode?: number | null; signalName?: string | null } | null
  alreadyNoSandbox?: boolean
  alreadySoftware?: boolean
  sandboxRelaunchAttempted?: boolean
  softwareRelaunchAttempted?: boolean
}): LinuxGpuDeathPath {
  if ((options.platform ?? process.platform) !== 'linux') {
    return null
  }

  const type = String(options.details?.type || '').toLowerCase()

  if (type !== 'gpu') {
    return null
  }

  const reason = String(options.details?.reason || '').toLowerCase()

  const sandboxSignature =
    options.details?.exitCode === GPU_CHILD_SANDBOX_SIGTERM_EXIT &&
    String(options.details?.signalName || '').toUpperCase() === 'SIGTERM'

  if (sandboxSignature && !options.alreadyNoSandbox && !options.sandboxRelaunchAttempted) {
    return 'no-sandbox'
  }

  if (GPU_FAILURE_REASONS.has(reason) && !options.alreadySoftware && !options.softwareRelaunchAttempted) {
    return 'disable-gpu'
  }

  return null
}

/**
 * #97616: `HERMES_DESKTOP_DISABLE_GPU=1` must fully prevent the GPU process,
 * not just compositing. `disableHardwareAcceleration()` alone provably still
 * spawns a GPU child (which then fails error_code=1002 on AMD/Mesa). The
 * remote-display detection reasons keep their long-standing compositing-only
 * behavior; only the explicit env override gains the spawn-blocking switch.
 */
export function disableGpuSwitchNeededForReason(remoteDisplayReason: string | null): boolean {
  return typeof remoteDisplayReason === 'string' && remoteDisplayReason.startsWith('override')
}

/**
 * #124843 silent-retry manifestation: the app boots "successfully" (window
 * reveals, marker flips to ok) while a sub-zygote retries GPU init forever —
 * no `child-process-gone` event ever fires. N seconds after the main window
 * reveals, the absence of a `--type=gpu-process` child on a boot that was
 * supposed to have one means the retry loop is running: engage the sticky
 * software fallback. A GPU child present, a non-Linux host, software already
 * on, or the check run before the grace window elapsed all decline.
 */
export function shouldEngageSilentGpuRetryFallback(options: {
  platform?: NodeJS.Platform | string
  gpuChildPresent?: boolean
  graceElapsed?: boolean
  alreadySoftware?: boolean
}): boolean {
  if ((options.platform ?? process.platform) !== 'linux') {
    return false
  }

  if (options.alreadySoftware || !options.graceElapsed || options.gpuChildPresent) {
    return false
  }

  return true
}
