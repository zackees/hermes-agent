import { describe, expect, it } from 'vitest'

import {
  decideNvidiaEglFallback,
  NVIDIA_GPU_DEATH_REASONS,
  parseNvidiaDriverMajor,
  parseNvidiaDriverVersion,
  shouldRelaunchForNvidiaGpuDeath
} from './linux-nvidia-egl-fallback'

const LINUX = { env: {}, platform: 'linux' as const, isWsl: false, remoteDisplayReason: null }
const PROBE = { ...LINUX, driverMajor: 580, ledger: null }
const EVIDENCE = { software: true, reason: 'witnessed GPU-process death; re-probe after 5 more launches' }

describe('parseNvidiaDriverMajor / parseNvidiaDriverVersion', () => {
  it('parses the major and full version from /proc/driver/nvidia/version content', () => {
    const text = 'NVRM version: NVIDIA UNIX x86_64 Kernel Module  580.82.09  Mon Jul 21 19:44:16 UTC 2025\n'

    expect(parseNvidiaDriverMajor(text)).toBe(580)
    expect(parseNvidiaDriverVersion(text)).toBe('580.82.09')
  })

  it('returns null for garbage or empty input', () => {
    expect(parseNvidiaDriverMajor('')).toBeNull()
    expect(parseNvidiaDriverMajor('no driver version here')).toBeNull()
    expect(parseNvidiaDriverVersion('')).toBeNull()
    expect(parseNvidiaDriverVersion('no driver version here')).toBeNull()
  })
})

// ─── the behavioral probe (#124255, talos-hq/hermes-slim#6) ───────────────────
//
// Only ledger evidence (a witnessed death or a rapid boot loop) may route ANGLE
// through SwiftShader; the ledger's own policy is covered in
// linux-gpu-launch-ledger.test.ts.

describe('decideNvidiaEglFallback — ledger-driven', () => {
  it('boots with hardware GL without ledger evidence: the driver is probed, not assumed broken', () => {
    expect(decideNvidiaEglFallback(PROBE)).toEqual({ enable: false, reason: null })
    expect(decideNvidiaEglFallback({ ...PROBE, ledger: { software: false, reason: null } }).enable).toBe(false)
  })

  it('ledger evidence engages SwiftShader and carries its reason', () => {
    const decision = decideNvidiaEglFallback({ ...PROBE, ledger: EVIDENCE })

    expect(decision.enable).toBe(true)
    expect(decision.reason).toContain('witnessed')
  })
})

describe('decideNvidiaEglFallback — exclusions', () => {
  it('stays off on non-linux platforms and without an NVIDIA driver', () => {
    expect(decideNvidiaEglFallback({ ...PROBE, ledger: EVIDENCE, platform: 'darwin' }).enable).toBe(false)
    expect(decideNvidiaEglFallback({ ...PROBE, ledger: EVIDENCE, platform: 'win32' }).enable).toBe(false)
    expect(decideNvidiaEglFallback({ ...PROBE, ledger: EVIDENCE, driverMajor: null }).enable).toBe(false)
  })

  it('stays off under WSLg and when a remote display already forced software rendering', () => {
    expect(decideNvidiaEglFallback({ ...PROBE, ledger: EVIDENCE, isWsl: true }).enable).toBe(false)
    expect(decideNvidiaEglFallback({ ...PROBE, ledger: EVIDENCE, remoteDisplayReason: 'ssh-session' }).enable).toBe(
      false
    )
  })

  it('HERMES_DESKTOP_DISABLE_GPU=0 keeps the GPU on even over ledger evidence', () => {
    expect(
      decideNvidiaEglFallback({ ...PROBE, ledger: EVIDENCE, env: { HERMES_DESKTOP_DISABLE_GPU: '0' } }).enable
    ).toBe(false)
  })

  it('HERMES_DESKTOP_NVIDIA_SWIFTSHADER forces the fallback on without evidence', () => {
    const decision = decideNvidiaEglFallback({ ...PROBE, env: { HERMES_DESKTOP_NVIDIA_SWIFTSHADER: '1' } })

    expect(decision.enable).toBe(true)
    expect(decision.reason).toContain('override')
  })

  it('HERMES_DESKTOP_NVIDIA_SWIFTSHADER=0 opts out even over ledger evidence', () => {
    expect(
      decideNvidiaEglFallback({ ...PROBE, ledger: EVIDENCE, env: { HERMES_DESKTOP_NVIDIA_SWIFTSHADER: 'off' } }).enable
    ).toBe(false)
  })
})

// ─── the runtime witness ────────────────────────────────────────────────────

describe('shouldRelaunchForNvidiaGpuDeath', () => {
  const BASE = { platform: 'linux' as const, fallbackActive: false, relaunchAttempted: false }

  it('relaunches on a GPU crash', () => {
    expect(shouldRelaunchForNvidiaGpuDeath({ ...BASE, details: { type: 'GPU', reason: 'crashed' } })).toBe(true)
  })

  it('relaunches on a GPU launch failure', () => {
    expect(shouldRelaunchForNvidiaGpuDeath({ ...BASE, details: { type: 'GPU', reason: 'launch-failure' } })).toBe(true)
  })

  it("counts `killed`: the #40077 GPU process died to Chromium's health-check SIGTERM (exit_code=15)", () => {
    expect(NVIDIA_GPU_DEATH_REASONS.has('killed')).toBe(true)
    expect(shouldRelaunchForNvidiaGpuDeath({ ...BASE, details: { type: 'GPU', reason: 'killed' } })).toBe(true)
  })

  it('never relaunches twice in one process, or when the fallback is already active', () => {
    const details = { type: 'GPU', reason: 'crashed' }

    expect(shouldRelaunchForNvidiaGpuDeath({ ...BASE, details, relaunchAttempted: true })).toBe(false)
    expect(shouldRelaunchForNvidiaGpuDeath({ ...BASE, details, fallbackActive: true })).toBe(false)
  })

  it('ignores non-GPU deaths, clean exits, and other platforms', () => {
    expect(shouldRelaunchForNvidiaGpuDeath({ ...BASE, details: { type: 'renderer', reason: 'crashed' } })).toBe(false)
    expect(shouldRelaunchForNvidiaGpuDeath({ ...BASE, details: { type: 'GPU', reason: 'clean-exit' } })).toBe(false)
    expect(shouldRelaunchForNvidiaGpuDeath({ ...BASE, details: null })).toBe(false)
    expect(
      shouldRelaunchForNvidiaGpuDeath({ ...BASE, platform: 'darwin', details: { type: 'GPU', reason: 'crashed' } })
    ).toBe(false)
  })
})
