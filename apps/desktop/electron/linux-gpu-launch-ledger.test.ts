import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  appendLedgerEvent,
  BOOT_LOOP_WINDOW_MS,
  compactLedger,
  createLaunchRecorder,
  decideFromLedger,
  LEDGER_MAX_ENTRIES,
  type LedgerEvent,
  type LedgerEventKind,
  linuxGpuLedgerPath,
  parseLedger,
  readLedger,
  REPROBE_BASE_LAUNCHES,
  REPROBE_BASE_MS,
  summarizeLaunches
} from './linux-gpu-launch-ledger'

const MIN = 60 * 1000
const DAY = 24 * 60 * MIN

const tmpDirs: string[] = []

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function tmpUserData(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gpu-ledger-'))
  tmpDirs.push(dir)

  return dir
}

/** Build a ledger from launch scripts: [startTime, mode, ...follow-up events]. */
function ledger(...launches: Array<[number, 'hardware' | 'software', ...LedgerEventKind[]]>): LedgerEvent[] {
  return launches.flatMap(([t, mode, ...evs], i) => [
    { t, launch: `L${i}`, ev: 'start' as const, mode },
    ...evs.map(ev => ({ t: t + 1000, launch: `L${i}`, ev }))
  ])
}

const decide = (events: LedgerEvent[], now: number) => decideFromLedger(summarizeLaunches(events), now)

describe('summarizeLaunches', () => {
  it('classifies healthy, gpu-death, aborted and neutral launches', () => {
    const summary = summarizeLaunches(
      ledger(
        [1, 'hardware', 'revealed'],
        [2, 'hardware', 'revealed', 'gpu-death'],
        [3, 'hardware'],
        [4, 'hardware', 'second-instance'],
        [5, 'hardware', 'clean-exit'],
        [6, 'software']
      )
    )

    expect(summary.map(l => l.outcome)).toEqual(['healthy', 'gpu-death', 'aborted', 'neutral', 'neutral', 'neutral'])
  })

  it('ignores events for launches whose start was compacted away', () => {
    expect(summarizeLaunches([{ t: 1, launch: 'orphan', ev: 'revealed' }])).toEqual([])
  })
})

describe('decideFromLedger — force-kills never wedge the app (talos-hq/hermes-slim#6)', () => {
  it('first launch probes hardware', () => {
    expect(decide([], 0).software).toBe(false)
  })

  it('a launch force-killed after its window revealed is healthy', () => {
    // revealed, then SIGKILL: no clean-exit ever lands
    expect(decide(ledger([0, 'hardware', 'revealed']), MIN).software).toBe(false)
  })

  it('a single pre-reveal force-kill is noise', () => {
    expect(decide(ledger([0, 'hardware', 'revealed'], [DAY, 'hardware']), DAY + MIN).software).toBe(false)
  })

  it('second-instance launches never count, however many', () => {
    const events = ledger(
      [0, 'hardware', 'revealed'],
      [1 * MIN, 'hardware', 'second-instance'],
      [2 * MIN, 'hardware', 'second-instance'],
      [3 * MIN, 'hardware', 'second-instance'],
      [4 * MIN, 'hardware', 'second-instance']
    )

    expect(decide(events, 5 * MIN).software).toBe(false)
  })

  it('occasional pre-reveal kills spread over days do not form a boot loop', () => {
    const events = ledger([0, 'hardware'], [DAY, 'hardware'], [2 * DAY, 'hardware'], [3 * DAY, 'hardware'])

    expect(decide(events, 3 * DAY + MIN).software).toBe(false)
  })

  it('the exact wedge from the issue — leftover pre-reveal abort with a 0.0.0 build — recovers', () => {
    // Old code: one `booting` leftover → sticky fallback forever.
    expect(decide(ledger([0, 'hardware', 'revealed'], [MIN, 'hardware']), 2 * MIN).software).toBe(false)
  })
})

describe('decideFromLedger — real failures recover in CPU mode', () => {
  it('a witnessed GPU death engages software rendering', () => {
    const decision = decide(ledger([0, 'hardware', 'gpu-death']), MIN)

    expect(decision.software).toBe(true)
    expect(decision.reason).toContain('witnessed')
  })

  it('three rapid pre-reveal aborts are a boot loop', () => {
    const events = ledger([0, 'hardware'], [MIN, 'hardware'], [2 * MIN, 'hardware'])
    const decision = decide(events, 3 * MIN)

    expect(decision.software).toBe(true)
    expect(decision.reason).toContain('boot loop')
  })

  it('an abort streak broken by a gap longer than the window is not a loop', () => {
    const events = ledger([0, 'hardware'], [MIN, 'hardware'], [MIN + BOOT_LOOP_WINDOW_MS + 1, 'hardware'])

    expect(decide(events, 2 * BOOT_LOOP_WINDOW_MS).software).toBe(false)
  })

  it('a healthy hardware boot clears all earlier evidence', () => {
    const events = ledger(
      [0, 'hardware', 'gpu-death'],
      [MIN, 'software', 'revealed'],
      [2 * DAY, 'hardware', 'revealed']
    )

    expect(decide(events, 2 * DAY + MIN).software).toBe(false)
  })
})

describe('decideFromLedger — software mode is never permanent', () => {
  const death = ledger([0, 'hardware', 'gpu-death'])

  const withSoftwareLaunches = (n: number, base: LedgerEvent[] = death, from = 1) => [
    ...base,
    ...ledger(
      ...Array.from({ length: n }, (_, i): [number, 'software', LedgerEventKind] => [from + i, 'software', 'revealed'])
    ).map(e => ({ ...e, launch: `S${from}-${e.launch}` }))
  ]

  it('re-probes hardware after REPROBE_BASE_LAUNCHES software launches', () => {
    expect(decide(withSoftwareLaunches(REPROBE_BASE_LAUNCHES - 1), MIN).software).toBe(true)

    const decision = decide(withSoftwareLaunches(REPROBE_BASE_LAUNCHES), MIN)

    expect(decision.software).toBe(false)
    expect(decision.reason).toContain('re-probing')
  })

  it('re-probes hardware after REPROBE_BASE_MS even without launches', () => {
    expect(decide(death, REPROBE_BASE_MS - 1).software).toBe(true)
    expect(decide(death, REPROBE_BASE_MS).software).toBe(false)
  })

  it('a failed re-probe doubles the interval', () => {
    const reprobeFailed = [
      ...withSoftwareLaunches(REPROBE_BASE_LAUNCHES),
      ...ledger([100, 'hardware', 'gpu-death']).map(e => ({ ...e, launch: 'R' }))
    ]

    expect(decide(withSoftwareLaunches(REPROBE_BASE_LAUNCHES, reprobeFailed, 200), 200).software).toBe(true)
    expect(decide(withSoftwareLaunches(2 * REPROBE_BASE_LAUNCHES, reprobeFailed, 200), 200).software).toBe(false)
  })
})

describe('ledger persistence', () => {
  it('round-trips through the userData dir and skips torn lines', () => {
    const dir = tmpUserData()

    appendLedgerEvent(dir, { t: 1, launch: 'a', ev: 'start', mode: 'hardware' })
    writeFileSync(linuxGpuLedgerPath(dir), readFileSync(linuxGpuLedgerPath(dir), 'utf8') + '{"t":2,"lau', 'utf8')

    expect(readLedger(dir)).toEqual([{ t: 1, launch: 'a', ev: 'start', mode: 'hardware' }])
    expect(parseLedger('garbage\n{"t":1,"launch":"x","ev":"bogus"}\n')).toEqual([])
  })

  it('returns an empty ledger when the file is missing', () => {
    expect(readLedger(tmpUserData())).toEqual([])
  })

  it('compacts to the newest LEDGER_MAX_ENTRIES', () => {
    const dir = tmpUserData()

    const events = Array.from({ length: LEDGER_MAX_ENTRIES + 10 }, (_, i): LedgerEvent => ({
      t: i,
      launch: `l${i}`,
      ev: 'start'
    }))

    compactLedger(dir, events)

    const kept = readLedger(dir)

    expect(kept).toHaveLength(LEDGER_MAX_ENTRIES)
    expect(kept[0].t).toBe(10)
  })

  it('the recorder writes once-per-launch facts once and tags every event with its launch id', () => {
    const dir = tmpUserData()
    const recorder = createLaunchRecorder(dir, { now: () => 5, pid: 42 })

    recorder.record('start', { mode: 'hardware' })
    recorder.record('revealed')
    recorder.record('revealed')
    recorder.record('gpu-death', { reason: 'crashed' })

    const events = readLedger(dir)

    expect(events.map(e => e.ev)).toEqual(['start', 'revealed', 'gpu-death'])
    expect(new Set(events.map(e => e.launch))).toEqual(new Set([recorder.launch]))
  })

  it('an empty userData dir makes the recorder a no-op', () => {
    expect(() => createLaunchRecorder('').record('start')).not.toThrow()
  })
})
