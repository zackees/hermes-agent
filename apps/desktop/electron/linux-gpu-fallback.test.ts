import { describe, expect, it } from 'vitest'

import {
  decideLinuxGpuLaunch,
  disableGpuSwitchNeededForReason,
  linuxGpuChildDeathPath,
  shouldEngageSilentGpuRetryFallback,
  shouldRelaunchForLinuxGpuCrash
} from './linux-gpu-fallback'

const LINUX = {
  platform: 'linux' as const,
  argv: [] as string[],
  env: {} as NodeJS.ProcessEnv,
  ledger: null,
  remoteDisplayReason: null as string | null,
  nvidiaFallbackActive: false
}

const EVIDENCE = { software: true, reason: 'pre-reveal boot loop; re-probe after 5 more launches' }

describe('decideLinuxGpuLaunch', () => {
  it('stays off without ledger evidence', () => {
    expect(decideLinuxGpuLaunch(LINUX)).toEqual({ enable: false, reason: null })
    expect(decideLinuxGpuLaunch({ ...LINUX, ledger: { software: false, reason: null } }).enable).toBe(false)
  })

  it('stays off on non-linux platforms', () => {
    expect(decideLinuxGpuLaunch({ ...LINUX, ledger: EVIDENCE, platform: 'darwin' }).enable).toBe(false)
  })

  it('engages software rendering from ledger evidence', () => {
    const decision = decideLinuxGpuLaunch({ ...LINUX, ledger: EVIDENCE })

    expect(decision.enable).toBe(true)
    expect(decision.reason).toContain('boot loop')
  })

  it('HERMES_DESKTOP_DISABLE_GPU=0 keeps the GPU on over ledger evidence', () => {
    expect(decideLinuxGpuLaunch({ ...LINUX, ledger: EVIDENCE, env: { HERMES_DESKTOP_DISABLE_GPU: '0' } }).enable).toBe(
      false
    )
  })

  it('stays off when software rendering is already forced', () => {
    expect(decideLinuxGpuLaunch({ ...LINUX, ledger: EVIDENCE, remoteDisplayReason: 'ssh-session' }).enable).toBe(false)
    expect(decideLinuxGpuLaunch({ ...LINUX, ledger: EVIDENCE, nvidiaFallbackActive: true }).enable).toBe(false)
    expect(decideLinuxGpuLaunch({ ...LINUX, argv: ['--disable-gpu'] }).reason).toBe('already-enabled')
  })
})

describe('shouldRelaunchForLinuxGpuCrash', () => {
  it('relaunches once on a GPU launch failure (error_code=1002 class)', () => {
    expect(
      shouldRelaunchForLinuxGpuCrash({
        platform: 'linux',
        details: { type: 'GPU', reason: 'launch-failure' },
        alreadySoftware: false,
        relaunchAttempted: false
      })
    ).toBe(true)
  })

  it('relaunches once on a GPU crash (SIGTRAP class)', () => {
    expect(
      shouldRelaunchForLinuxGpuCrash({
        platform: 'linux',
        details: { type: 'gpu', reason: 'crashed' },
        alreadySoftware: false,
        relaunchAttempted: false
      })
    ).toBe(true)
  })

  it('never relaunches twice in one process', () => {
    expect(
      shouldRelaunchForLinuxGpuCrash({
        platform: 'linux',
        details: { type: 'GPU', reason: 'launch-failure' },
        alreadySoftware: false,
        relaunchAttempted: true
      })
    ).toBe(false)
  })

  it('ignores non-GPU deaths and clean exits', () => {
    const base = { platform: 'linux' as const, alreadySoftware: false, relaunchAttempted: false }

    expect(shouldRelaunchForLinuxGpuCrash({ ...base, details: { type: 'renderer', reason: 'crashed' } })).toBe(false)
    expect(shouldRelaunchForLinuxGpuCrash({ ...base, details: { type: 'GPU', reason: 'clean-exit' } })).toBe(false)
    expect(shouldRelaunchForLinuxGpuCrash({ ...base, details: null })).toBe(false)
  })

  it('stays off when software rendering is already active or off linux', () => {
    expect(
      shouldRelaunchForLinuxGpuCrash({
        platform: 'linux',
        details: { type: 'GPU', reason: 'crashed' },
        alreadySoftware: true,
        relaunchAttempted: false
      })
    ).toBe(false)
    expect(
      shouldRelaunchForLinuxGpuCrash({
        platform: 'win32',
        details: { type: 'GPU', reason: 'crashed' },
        alreadySoftware: false,
        relaunchAttempted: false
      })
    ).toBe(false)
  })
})

describe('linuxGpuChildDeathPath', () => {
  const SIGTERM_DEATH = { type: 'GPU', reason: 'crashed', exitCode: 143, signalName: 'SIGTERM' }

  it('prefers the sandbox ladder on the #121954 SIGTERM signature', () => {
    expect(linuxGpuChildDeathPath({ platform: 'linux', details: SIGTERM_DEATH })).toBe('no-sandbox')
  })

  it('falls to software when the sandbox relaunch was already spent (relapse)', () => {
    expect(
      linuxGpuChildDeathPath({
        platform: 'linux',
        details: SIGTERM_DEATH,
        sandboxRelaunchAttempted: true
      })
    ).toBe('disable-gpu')
    expect(
      linuxGpuChildDeathPath({
        platform: 'linux',
        details: SIGTERM_DEATH,
        alreadyNoSandbox: true
      })
    ).toBe('disable-gpu')
  })

  it('sends non-signature GPU failures straight to software', () => {
    expect(
      linuxGpuChildDeathPath({
        platform: 'linux',
        details: { type: 'GPU', reason: 'launch-failure', exitCode: 1002 }
      })
    ).toBe('disable-gpu')
    expect(
      linuxGpuChildDeathPath({ platform: 'linux', details: { type: 'GPU', reason: 'crashed', exitCode: 139 } })
    ).toBe('disable-gpu')
  })

  it('produces at most one decision: both ladders spent or already on means none', () => {
    expect(
      linuxGpuChildDeathPath({
        platform: 'linux',
        details: SIGTERM_DEATH,
        sandboxRelaunchAttempted: true,
        softwareRelaunchAttempted: true
      })
    ).toBeNull()
    expect(
      linuxGpuChildDeathPath({
        platform: 'linux',
        details: { type: 'GPU', reason: 'crashed' },
        alreadySoftware: true
      })
    ).toBeNull()
  })

  it('ignores non-GPU deaths and other platforms', () => {
    expect(linuxGpuChildDeathPath({ platform: 'linux', details: { type: 'Renderer', reason: 'crashed' } })).toBeNull()
    expect(linuxGpuChildDeathPath({ platform: 'darwin', details: SIGTERM_DEATH })).toBeNull()
    expect(linuxGpuChildDeathPath({ platform: 'linux' })).toBeNull()
  })

  it('requires the full SIGTERM signature for the sandbox path, not just exit 143', () => {
    expect(
      linuxGpuChildDeathPath({
        platform: 'linux',
        details: { type: 'GPU', reason: 'crashed', exitCode: 143, signalName: 'SIGKILL' }
      })
    ).toBe('disable-gpu')
    // #121954's contract (shouldRelaunchForGpuSandboxCrash) checks the
    // signal signature only: a GPU child SIGTERMed by Chromium is its own
    // "never became usable" shutdown — the reason string carries no extra
    // signal (an OOM would arrive as SIGKILL, above).
    expect(
      linuxGpuChildDeathPath({
        platform: 'linux',
        details: { type: 'GPU', reason: 'oom', exitCode: 143, signalName: 'SIGTERM' }
      })
    ).toBe('no-sandbox')
  })
})

describe('disableGpuSwitchNeededForReason', () => {
  it('spawn-blocks the GPU process only for the explicit env override', () => {
    expect(disableGpuSwitchNeededForReason('override (HERMES_DESKTOP_DISABLE_GPU)')).toBe(true)
    expect(disableGpuSwitchNeededForReason('ssh-session')).toBe(false)
    expect(disableGpuSwitchNeededForReason('vnc-session')).toBe(false)
    expect(disableGpuSwitchNeededForReason(null)).toBe(false)
  })
})

describe('shouldEngageSilentGpuRetryFallback', () => {
  it('engages only on Linux, after the grace window, with no GPU child, not already software', () => {
    expect(shouldEngageSilentGpuRetryFallback({ platform: 'linux', gpuChildPresent: false, graceElapsed: true })).toBe(
      true
    )
    expect(shouldEngageSilentGpuRetryFallback({ platform: 'linux', gpuChildPresent: true, graceElapsed: true })).toBe(
      false
    )
    expect(shouldEngageSilentGpuRetryFallback({ platform: 'linux', gpuChildPresent: false, graceElapsed: false })).toBe(
      false
    )
    expect(
      shouldEngageSilentGpuRetryFallback({
        platform: 'linux',
        gpuChildPresent: false,
        graceElapsed: true,
        alreadySoftware: true
      })
    ).toBe(false)
    expect(shouldEngageSilentGpuRetryFallback({ platform: 'darwin', gpuChildPresent: false, graceElapsed: true })).toBe(
      false
    )
  })
})
