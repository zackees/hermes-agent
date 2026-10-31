/**
 * Linux NVIDIA EGL fallback for #40077 / #124255.
 *
 * History: NVIDIA driver 580.x breaks ANGLE's EGL probing on X11/Wayland
 * ("Invalid visual ID requested"), the GPU process dies, and the app goes down
 * with it. Rendering ANGLE through SwiftShader (`--use-angle=swiftshader`)
 * skips the NVIDIA EGL probe entirely, so the app launches and stays up — at
 * the cost of CPU compositing.
 *
 * The gate used to be a driver-major set (first `>= 580`, then the closed
 * `{580}` from #123213). But the same driver point release breaks one host and
 * not another — 580.178.04 kills the GPU process on a desktop where NVIDIA
 * drives the display (#40077, #124032) and renders fine on hybrid hosts whose
 * session EGL lands on the iGPU (#124255, psukez on #123203). A driver-series
 * bound cannot separate them, and the all-CPU SwiftShader fallback converts a
 * known Chromium stuck-Button-observer leak (~0 cost with GPU compositing)
 * into a 4–9 core burn on every healthy 580 host.
 *
 * So the gate is behavioral (#124255 Option A): a Linux + NVIDIA host boots
 * with hardware GL. A GPU-process death before (or shortly after) the first
 * window reveal is recorded in the launch ledger and the app relaunches once
 * with `--use-angle=swiftshader`. Later launches stay on SwiftShader only while
 * the ledger holds that evidence, re-probing hardware GL with backoff. A
 * pre-reveal abort with no witnessed death (Chromium's FATAL abort winning the
 * race, or just a force-kill) counts only as part of a rapid boot loop — see
 * linux-gpu-launch-ledger.ts and talos-hq/hermes-slim#6.
 *
 * Deliberately NOT `app.disableHardwareAcceleration()`: on 580.173.02 +
 * Electron 40 that path SIGKILLs the renderer (see #40077 discussion, and the
 * closed #40119 which was rejected for exactly this). We only reroute ANGLE;
 * we never disable the GPU pipeline wholesale.
 *
 * Skipped when a remote display already forced software rendering, under WSLg
 * (vGPU is healthy there), or when `HERMES_DESKTOP_DISABLE_GPU=0` keeps the
 * GPU on. `HERMES_DESKTOP_NVIDIA_SWIFTSHADER=1` forces the fallback on;
 * `=0` opts out entirely.
 *
 * Pure + dependency-free so it can be unit-tested and called before app ready.
 */

import fs from 'node:fs'
import path from 'node:path'

import type { LedgerGpuDecision } from './linux-gpu-launch-ledger'

const OVERRIDE_ON = new Set(['1', 'true', 'yes', 'on'])
const OVERRIDE_OFF = new Set(['0', 'false', 'no', 'off'])

/** Legacy single-slot marker, superseded by the launch ledger; deleted at launch. */
export const NVIDIA_EGL_FALLBACK_MARKER_FILENAME = 'nvidia-egl-fallback.json'

/**
 * `child-process-gone` reasons that witness a broken GPU child. `killed` is
 * included on purpose: in #40077 the GPU process exited with exit_code=15 —
 * Chromium's own GPU health check SIGTERM — not a crash reason.
 */
export const NVIDIA_GPU_DEATH_REASONS: ReadonlySet<string> = new Set(['crashed', 'launch-failure', 'killed'])

export function nvidiaEglMarkerPath(userDataDir: string): string {
  return path.join(String(userDataDir || ''), NVIDIA_EGL_FALLBACK_MARKER_FILENAME)
}

/** Remove the legacy marker: its `booting`/`fallback` states wedged hosts (talos-hq/hermes-slim#6). */
export function removeLegacyNvidiaEglMarker(userDataDir: string, { rmSync = fs.rmSync } = {}): void {
  try {
    rmSync(nvidiaEglMarkerPath(userDataDir), { force: true })
  } catch {
    void 0
  }
}

/**
 * Extract the driver major version from /proc/driver/nvidia/version content.
 * Format: "NVRM version: NVIDIA UNIX x86_64 Kernel Module  580.82.09 ..."
 */
export function parseNvidiaDriverMajor(procVersion: string): number | null {
  const match = /\b(\d{3,})\.\d+\.\d+\b/.exec(String(procVersion || ''))

  if (!match) {
    return null
  }

  const major = Number.parseInt(match[1], 10)

  return Number.isFinite(major) ? major : null
}

/**
 * Extract the FULL driver version ("580.178.04") from /proc/driver/nvidia/version.
 * Recorded on ledger `start` events for diagnostics.
 */
export function parseNvidiaDriverVersion(procVersion: string): string | null {
  const match = /\b(\d{3,}\.\d+\.\d+)\b/.exec(String(procVersion || ''))

  return match ? match[1] : null
}

export interface NvidiaEglFallbackDecision {
  enable: boolean
  reason: string | null
}

/**
 * Single launch-time decision: whether this Linux NVIDIA launch routes ANGLE
 * through SwiftShader. Evidence comes from the launch ledger
 * (`linux-gpu-launch-ledger.ts`), which only counts witnessed GPU deaths and
 * rapid pre-reveal boot loops, and re-probes hardware GL with backoff — an
 * occasional force-kill or second-instance launch never engages it.
 *
 * The env override `HERMES_DESKTOP_NVIDIA_SWIFTSHADER=1` forces the fallback
 * on; `=0` keeps it off.
 */
export function decideNvidiaEglFallback(options: {
  driverMajor: number | null
  ledger?: LedgerGpuDecision | null
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  isWsl?: boolean
  remoteDisplayReason?: string | null
}): NvidiaEglFallbackDecision {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const off: NvidiaEglFallbackDecision = { enable: false, reason: null }

  const nvidiaOverride = String(env.HERMES_DESKTOP_NVIDIA_SWIFTSHADER || '')
    .trim()
    .toLowerCase()

  if (OVERRIDE_OFF.has(nvidiaOverride)) {
    return off
  }

  if (platform !== 'linux' || options.driverMajor === null) {
    return off
  }

  // A user who forced GPU back on (HERMES_DESKTOP_DISABLE_GPU=0) owns that call.
  const gpuOverride = String(env.HERMES_DESKTOP_DISABLE_GPU || '')
    .trim()
    .toLowerCase()

  if (OVERRIDE_OFF.has(gpuOverride)) {
    return off
  }

  // The remote-display path already forces full software rendering; don't pile
  // ANGLE switches on top of `disableHardwareAcceleration`.
  if (options.remoteDisplayReason) {
    return off
  }

  // WSLg reports a healthy vGPU; NVIDIA EGL probing hasn't been reported
  // broken there. Keep the WSL GPU passthrough path untouched.
  if (options.isWsl ?? false) {
    return off
  }

  if (OVERRIDE_ON.has(nvidiaOverride)) {
    return { enable: true, reason: 'override (HERMES_DESKTOP_NVIDIA_SWIFTSHADER)' }
  }

  if (options.ledger?.software) {
    return { enable: true, reason: options.ledger.reason }
  }

  return off
}

export interface NvidiaGpuDeathOptions {
  platform?: NodeJS.Platform | string
  details: { type?: string; reason?: string } | null
  /** The fallback is already active this launch (ledger evidence or override). */
  fallbackActive: boolean
  /** This process already attempted the one-shot relaunch. */
  relaunchAttempted: boolean
}

/**
 * Whether a `child-process-gone` event witnesses the #40077 GPU death and
 * should trigger the one-shot SwiftShader relaunch. `killed` counts: the
 * #40077 GPU process exited with exit_code=15, Chromium's health-check
 * SIGTERM, not a crash reason.
 */
export function shouldRelaunchForNvidiaGpuDeath({
  platform = process.platform,
  details,
  fallbackActive,
  relaunchAttempted
}: NvidiaGpuDeathOptions): boolean {
  if (platform !== 'linux' || fallbackActive || relaunchAttempted) {
    return false
  }

  const type = String(details?.type ?? '').toLowerCase()
  const reason = String(details?.reason ?? '').toLowerCase()

  return (type === 'gpu' || type === 'gpu-process') && NVIDIA_GPU_DEATH_REASONS.has(reason)
}
