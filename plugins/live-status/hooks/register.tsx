import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Crew, Limit, Panel, Rtk, RtkScope, Run, SessionRow, Task, Turn, Usage } from '../types'

const NO_USAGE: Usage = { ctxPercent: null, ctxTokens: null, ctxWindow: 0, limits: [], costUsd: null }
const NO_TURN: Turn = { isRunning: false, startedAt: 0, steps: 0, tools: 0, lastSeconds: 0, agents: 0 }

const usage = atom({ plugin: 'live-status', key: 'usage' } as const, NO_USAGE)
const model = atom({ plugin: 'live-status', key: 'model' } as const, '')
const effort = atom({ plugin: 'live-status', key: 'effort' } as const, '')
const turn = atom({ plugin: 'live-status', key: 'turn' } as const, NO_TURN)
const task = atom({ plugin: 'live-status', key: 'task' } as const, null)
const crew = atom({ plugin: 'live-status', key: 'crew' } as const, { spawned: 0, done: 0 })
const runs = atom({ plugin: 'live-status', key: 'runs' } as const, [])
const rtk = atom({ plugin: 'live-status', key: 'rtk' } as const, null)
const sessions = atom({ plugin: 'live-status', key: 'sessions' } as const, [])
const panel = atom({ plugin: 'live-status', key: 'panel' } as const, { isCompact: false, isDoneCollapsed: true })
const now = atom({ plugin: 'live-status', key: 'now' } as const, 0)
const slow = atom({ plugin: 'live-status', key: 'slow' } as const, 0)

const PANE = 'live-agents'

// What the card shows for the work in hand: the reported task, else the crew.
type TaskView = { title: string; done: number; total: number; current: string; isFinished: boolean }

const taskView = (t: Task | null, c: Crew): TaskView | null => {
  if (t && t.total > 0) return { title: t.title, done: t.done, total: t.total, current: t.current, isFinished: t.isFinished }
  if (c.spawned > 0) return { title: 'Subagents', done: c.done, total: c.spawned, current: '', isFinished: c.done >= c.spawned }
  return null
}
const isHidden = atom({ plugin: 'live-status', key: 'isHidden' } as const, false)
const warned = atom({ plugin: 'live-status', key: 'warned' } as const, '')

// Terminal palette (raw colors, the terminal has no CSS).
const GREEN = '#5fbf8f'
const AMBER = '#FFBC25'
const RED = '#E5484D'
const BLUE = '#8f8cf4'

const tone = (pct: number): string => (pct >= 85 ? RED : pct >= 60 ? AMBER : GREEN)

const bar = (pct: number, width: number): string => {
  const filled = Math.max(0, Math.min(width, Math.round((width * pct) / 100)))
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

const modelName = (id: string): string => {
  const m = /(fable|mythos|opus|sonnet|haiku)-(\d+)(?:-(\d{1,2})(?!\d))?/i.exec(id)
  const [, family = '', major = '', minor] = m ?? []
  if (!family) return id.replace(/^claude-/, '').replace(/\[.*\]$/, '') || '...'
  return `${family.charAt(0).toUpperCase()}${family.slice(1).toLowerCase()} ${major}${minor ? '.' + minor : ''}`
}

const fmtTokens = (n: number): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${Math.round(n)}`

const fmtTime = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

const fmtCost = (usd: number): string => `$${usd < 10 ? usd.toFixed(2) : usd.toFixed(1)}`

const fmtReset = (iso: string | undefined, at: number): string => {
  if (!iso) return ''
  const ms = Date.parse(iso) - at
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const m = Math.round(ms / 60000)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h}h${String(m % 60).padStart(2, '0')}m` : `${Math.floor(h / 24)}d${h % 24}h`
}

const LIMIT_LABEL: Record<string, string> = { five_hour: '5H', seven_day: '7D', spend_limit: 'SPEND' }

type RawUsage = {
  context: { tokens?: number; window: number; percent?: number }
  rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[]
  cost?: { usd: number }
}

const fromUsage = (u: RawUsage): Usage => ({
  ctxPercent: u.context.percent ?? null,
  ctxTokens: u.context.tokens ?? null,
  ctxWindow: u.context.window,
  limits: u.rateLimits.map((r): Limit => ({ kind: r.kind, pct: r.percentUsed, resetsAt: r.resetsAt })),
  costUsd: u.cost?.usd ?? null,
})

async function refresh($: EngineInterface): Promise<void> {
  try {
    const u = await $.session.usage()
    await update($, usage, () => fromUsage(u))
  } catch {
    // Usage is not available yet; the next measure fills it in.
  }
}

// Before the first model step, the effort is whatever the person configured.
async function configuredEffort($: EngineInterface): Promise<string> {
  try {
    const fromEnv = await $.env.get('CLAUDE_EFFORT')
    if (fromEnv) return fromEnv
    const s = (await $.settings.read()) as Record<string, unknown>
    const level = s.effortLevel ?? s.effort
    return typeof level === 'string' ? level : ''
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------------------
// Desktop drawing: one SVG card. Only looping CSS motion, phase-locked to the
// wall clock through a negative animation-delay, so the once-a-second redraw
// of a running turn continues the motion instead of restarting it.

// Design tokens: Inter, soft grey surface, charcoal text, a yellow→orange rail,
// info / discovery / neutral lozenges, 12px card radius. Change colors in CSS below.
const FONT = "Inter,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif"
const EASE = 'cubic-bezier(.65,0,.35,1)' // ease-in-out, for on-screen motion

const xml = (s: string): string =>
  s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)

const charEm = (ch: string): number =>
  /[\s.,:;'|!il1()[\]]/.test(ch) ? 0.3 : /[A-Z@%MW]/.test(ch) ? 0.7 : 0.55

const textWidth = (s: string, size: number): number => [...s].reduce((w, ch) => w + charEm(ch) * size, 0)

const fitText = (s: string, size: number, maxW: number): string => {
  if (textWidth(s, size) <= maxW) return s
  let out = ''
  for (const ch of s) {
    if (textWidth(out + ch + '…', size) > maxW) break
    out += ch
  }
  return out + '…'
}

// Motion budget: the band keeps one light sweep (the bottom rail) while a turn runs;
// the shimmer on the bars costs more for little, so it is off.
const BAND_SHEEN = false

type AgentRow = { name: string; status: 'running' | 'done' | 'failed'; ctx: number }

type Gauge = { label: string; pct: number | null; caption: string; sheen: boolean; good?: boolean }

const gradFor = (pct: number | null): string => (pct === null ? 'gNone' : pct >= 85 ? 'gBad' : pct >= 60 ? 'gWarn' : 'gOk')

// Labels are tracked out by .9 a character, which textWidth does not know about.
const fitTracked = (s: string, size: number, track: number, maxW: number): string => {
  const w = (t: string): number => textWidth(t, size) + t.length * track
  if (w(s) <= maxW) return s
  let out = ''
  for (const ch of s) {
    if (w(out + ch + '…') > maxW) break
    out += ch
  }
  return out ? out + '…' : ''
}

// What a gauge column needs: its label and its percentage side by side.
const gaugeValueW = (g: Gauge): number => textWidth(g.pct === null ? '—' : `${Math.round(g.pct)}%`, 12)
const gaugeNeed = (gs: Gauge[]): number =>
  Math.max(0, ...gs.map(g => textWidth(g.label, 9.5) + g.label.length * 0.9 + gaugeValueW(g) + 16))

// Where the gauges sit, in the row layout and in the stacked one. The stack
// decision reads this too, so both agree on how wide a column really is.
// With a fourth gauge (RTK) the left block gives up some room.
const GPAD = 14
const GGAP = 18
const gaugeGeom = (W: number, stack: boolean, n: number): { leftW: number; gx0: number; gw: number } => {
  const leftW = stack
    ? W - GPAD * 2
    : n > 3
      ? Math.max(200, Math.min(290, Math.round(W * 0.3)))
      : Math.max(232, Math.min(330, Math.round(W * 0.38)))
  const gx0 = stack ? GPAD : GPAD + leftW + 22
  const gAreaW = stack ? W - GPAD * 2 : W - gx0 - GPAD
  return { leftW, gx0, gw: Math.floor((gAreaW - GGAP * (n - 1)) / Math.max(1, n)) }
}

// Stack as soon as a row of gauges would be too narrow to hold label and value apart.
const shouldStack = (W: number, gs: Gauge[]): boolean => W < 520 || gaugeGeom(W, false, gs.length).gw < gaugeNeed(gs)

const CSS = `
.card{fill:#F8F9FB;stroke:#D0D6DD}.nm{fill:#333333}.mu{fill:#626B79}.pc{fill:#232933}
.trk{fill:#FFF4D6}.tick{fill:#626B79}.chip{fill:#F1EBFD}.chipt{fill:#5B3BB0}.chipx{fill:none;stroke:#7D8695}.rail{fill:#EDF0F2}
.dot-ok{fill:#1F7A4D}.dot-run{fill:#1D5FBF}
.lz-run{fill:#E8F0FC}.lz-runt{fill:#1D5FBF}.lz-idle{fill:#EDF0F2}.lz-idlet{fill:#333333}
.lv-hi{fill:#B54708}.lv-bad{fill:#C62F2F}.seg{fill:#F8F9FB}
@media (prefers-color-scheme: dark){
.card{fill:#282828;stroke:#3F3F3F}.nm{fill:#FFFFFF}.mu{fill:#C4C9D0}.pc{fill:#FFFFFF}
.trk{fill:#3A3A38}.tick{fill:#9AA3AF}.chip{fill:#3A2F63}.chipt{fill:#D9CCFA}.chipx{stroke:#626B79}.rail{fill:#3A3A3A}
.dot-ok{fill:#4FD08F}.dot-run{fill:#6DA7EC}
.lz-run{fill:#1F3558}.lz-runt{fill:#B7D3F6}.lz-idle{fill:#3A3A3A}.lz-idlet{fill:#FFFFFF}
.lv-hi{fill:#EB6834}.lv-bad{fill:#FF7A78}.seg{fill:#282828}}
`

function cardSvg(args: {
  W: number
  stack: boolean
  name: string
  fx: string
  cost: string
  state: string
  detail: string
  isRunning: boolean
  gauges: Gauge[]
  task: TaskView | null
  agents: { rows: AgentRow[]; working: number; more: number }
  sessions?: { total: number; working: number; attention?: number }
  nowMs: number
}): { svg: string; H: number } {
  const { W, stack, name, fx, cost, state, detail, isRunning, gauges, task: tv, agents: ag, sessions: ss, nowMs } = args
  const PAD = 14
  const baseH = stack ? 118 : 76
  const taskH = tv ? 32 : 0
  const agentH = ag.rows.length ? 24 + ag.rows.length * 22 : 0
  const H = baseH + taskH + agentH
  const { leftW, gx0, gw } = gaugeGeom(W, stack, gauges.length)
  const gy0 = stack ? 58 : 17
  const gGap = GGAP

  const phase = (period: number): string => `-${((nowMs % (period * 1000)) / 1000).toFixed(2)}s`

  // Left block: orb, model, effort chip, cost, status line.
  const nameFit = fitText(name, 13, leftW - 120)
  const nameW = textWidth(nameFit, 13) * 1.04
  const chipText = (fx || 'effort ?').toUpperCase()
  const chipW = Math.round(textWidth(chipText, 9.5) + 16 + chipText.length * 0.6)
  const chipX = PAD + 20 + Math.round(nameW) + 8
  const known = fx !== ''
  const costX = PAD + leftW
  const sessText = ss && ss.total > 1 ? `${ss.total} sessions · ${ss.working} working${ss.attention ? ` · ${ss.attention} need you` : ''}` : ''
  const stateText = state.toUpperCase()
  const lzW = Math.round(textWidth(stateText, 9.5) + 16 + stateText.length * 0.6)
  const left = `
<g>
  <circle class="${isRunning ? 'dot-run' : 'dot-ok'}" cx="${PAD + 5}" cy="${PAD + 11}" r="4"/>
  <text class="nm" x="${PAD + 20}" y="${PAD + 15}" font-family="${FONT}" font-size="13" font-weight="650">${xml(nameFit)}</text>
  <rect class="${known ? 'chip' : 'chipx'}" x="${chipX}" y="${PAD + 3}" width="${chipW}" height="17" rx="8.5"${known ? '' : ' stroke-dasharray="2.5 2.5"'}/>
  <text class="${known ? 'chipt' : 'mu'}" x="${chipX + chipW / 2}" y="${PAD + 15}" text-anchor="middle" font-family="${FONT}" font-size="9.5" font-weight="700" letter-spacing=".6">${xml(chipText)}</text>
  ${cost ? `<text class="mu" x="${costX}" y="${PAD + 15}" text-anchor="end" font-family="${FONT}" font-size="11" font-weight="600" font-variant-numeric="tabular-nums">${xml(cost)}</text>` : ''}
  <rect class="${isRunning ? 'lz-run' : 'lz-idle'}" x="${PAD + 20}" y="${PAD + 26}" width="${lzW}" height="17" rx="8.5"/>
  <text class="${isRunning ? 'lz-runt' : 'lz-idlet'}" x="${PAD + 20 + lzW / 2}" y="${PAD + 38}" text-anchor="middle" font-family="${FONT}" font-size="9.5" font-weight="700" letter-spacing=".6">${xml(stateText)}</text>
  ${sessText ? `<text class="mu" x="${costX}" y="${PAD + 39}" text-anchor="end" font-family="${FONT}" font-size="10" font-weight="600">${xml(sessText)}</text>` : ''}
  <text class="mu" x="${PAD + 20 + lzW + 8}" y="${PAD + 39}" font-family="${FONT}" font-size="11">${xml(fitText(detail, 11, leftW - 22 - lzW - 8 - (sessText ? Math.round(textWidth(sessText, 10)) + 12 : 0)))}</text>
</g>`

  // Gauges.
  const keyframes: string[] = []
  const draw = gauges.map((g, i) => {
    const x = gx0 + i * (gw + gGap)
    const y = gy0
    const pct = g.pct === null ? 0 : Math.max(0, Math.min(100, g.pct))
    // Level is never colour alone: the word comes with it.
    const lvl = g.pct === null || g.good ? '' : pct >= 85 ? (gw < 112 ? 'CRIT' : 'CRITICAL') : pct >= 60 ? 'HIGH' : ''
    const fillW = g.pct === null ? 0 : Math.max(pct > 0 ? 6 : 0, Math.round((gw * pct) / 100))
    const ticks = [60, 85]
      .map(t => ({ t, tx: x + Math.round((gw * t) / 100) }))
      .filter(({ tx }) => !g.good && tx > x + fillW + 3)
      .map(({ tx }) => `<rect class="tick" x="${tx}" y="${y + 15}" width="1" height="8" rx=".5" opacity=".55"/>`)
      .join('')
    let sheen = ''
    if (BAND_SHEEN && isRunning && g.sheen && fillW > 12) {
      keyframes.push(`@keyframes sh${i}{0%{transform:translateX(-30px)}100%{transform:translateX(${fillW}px)}}`)
      sheen = `<clipPath id="cl${i}"><rect x="${x}" y="${y + 16}" width="${fillW}" height="6" rx="3"/></clipPath>
<g clip-path="url(#cl${i})"><rect x="${x}" y="${y + 16}" width="30" height="6" fill="url(#gSheen)" style="animation:sh${i} 1.6s ${EASE} infinite;animation-delay:${phase(1.6)}"/></g>`
    }
    // The label never runs into the percentage, however narrow the column gets.
    const lvlW = lvl ? textWidth(lvl, 9.5) + lvl.length * 0.9 + 9 : 0
    const labelFit = fitTracked(g.label, 9.5, 0.9, gw - gaugeValueW(g) - lvlW - 16)
    return `
<g>
  <text class="mu" x="${x}" y="${y + 10}" font-family="${FONT}" font-size="9.5" font-weight="700" letter-spacing=".9">${xml(labelFit)}${lvl ? `<tspan class="${pct >= 85 ? 'lv-bad' : 'lv-hi'}" dx="5">${lvl}</tspan>` : ''}</text>
  <text class="pc" x="${x + gw}" y="${y + 10}" text-anchor="end" font-family="${FONT}" font-size="12" font-weight="700" font-variant-numeric="tabular-nums">${g.pct === null ? '—' : Math.round(g.pct) + '%'}</text>
  <rect class="trk" x="${x}" y="${y + 16}" width="${gw}" height="6" rx="3"/>
  ${fillW ? `<rect x="${x}" y="${y + 16}" width="${fillW}" height="6" rx="3" fill="url(#${g.good ? 'gDone' : gradFor(g.pct)})"/>` : ''}
  ${sheen}${ticks}
  <text class="mu" x="${x}" y="${y + 38}" font-family="${FONT}" font-size="10" font-variant-numeric="tabular-nums">${xml(fitText(g.caption, 10, gw))}</text>
</g>`
  })

  // The task being worked on: full width, thicker than a gauge, segmented per step.
  let taskRow = ''
  if (tv) {
    const tx = PAD
    const ty = baseH - 10
    const tw = W - PAD * 2
    const pct = Math.max(0, Math.min(100, Math.round((tv.done / Math.max(1, tv.total)) * 100)))
    const fillW = pct > 0 ? Math.max(8, Math.round((tw * pct) / 100)) : 0
    const grad = tv.isFinished ? 'gDone' : 'gOk'
    const stepsText = `${tv.done}/${tv.total}`
    const right = `${stepsText}  ·  ${pct}%`
    const labelW = tw - textWidth(right, 12) - 24
    const head = `TASK${tv.title ? '  ' + tv.title : ''}${tv.current && !tv.isFinished ? '  ›  ' + tv.current : ''}`
    const segs: string[] = []
    if (tv.total <= 16) {
      for (let i = 1; i < tv.total; i++) {
        segs.push(`<rect class="seg" x="${tx + Math.round((tw * i) / tv.total) - 1}" y="${ty + 16}" width="2" height="8"/>`)
      }
    }
    let sheen = ''
    if (BAND_SHEEN && isRunning && !tv.isFinished && fillW > 16) {
      keyframes.push(`@keyframes sht{0%{transform:translateX(-36px)}100%{transform:translateX(${fillW}px)}}`)
      sheen = `<clipPath id="clt"><rect x="${tx}" y="${ty + 16}" width="${fillW}" height="8" rx="4"/></clipPath>
<g clip-path="url(#clt)"><rect x="${tx}" y="${ty + 16}" width="36" height="8" fill="url(#gSheen)" style="animation:sht 1.6s ${EASE} infinite;animation-delay:${phase(1.6)}"/></g>`
    }
    taskRow = `
<g>
  <text class="mu" x="${tx}" y="${ty + 10}" font-family="${FONT}" font-size="9.5" font-weight="700" letter-spacing=".9">${xml(fitText(head, 9.5, labelW))}</text>
  <text class="pc" x="${tx + tw}" y="${ty + 10}" text-anchor="end" font-family="${FONT}" font-size="12" font-weight="700" font-variant-numeric="tabular-nums">${xml(right)}</text>
  <rect class="trk" x="${tx}" y="${ty + 16}" width="${tw}" height="8" rx="4"/>
  ${fillW ? `<rect x="${tx}" y="${ty + 16}" width="${fillW}" height="8" rx="4" fill="url(#${grad})"/>` : ''}
  ${sheen}${segs.join('')}
</g>`
  }

  // Subagents inline, for when the agents panel has no room (narrow window): one
  // compact row each, newest working first.
  let agentBlock = ''
  if (ag.rows.length) {
    const ay = baseH - 10 + taskH
    const barW = Math.max(48, Math.min(120, Math.round(W * 0.16)))
    const head = `AGENTS  ·  ${ag.working} working${ag.more ? `  ·  +${ag.more} more` : ''}`
    const rows = ag.rows.map((r, i) => {
      const y = ay + 22 + i * 22
      const fill = Math.round((barW * r.ctx) / 100)
      const dot = r.status === 'running' ? 'dot-run' : r.status === 'done' ? 'dot-ok' : 'lv-bad'
      const word = r.status === 'running' ? '' : r.status === 'done' ? 'done' : 'failed'
      const barX = W - PAD - 40 - barW
      const wordW = word ? Math.round(textWidth(word, 10) + 10) : 0
      const nameW = barX - wordW - (PAD + 16) - 10
      const grad = r.ctx >= 85 ? 'gBad' : r.ctx >= 60 ? 'gWarn' : 'gOk'
      return `
<circle class="${dot}" cx="${PAD + 5}" cy="${y + 7}" r="3"/>
<text class="nm" x="${PAD + 16}" y="${y + 11}" font-family="${FONT}" font-size="11" font-weight="600">${xml(fitText(r.name, 11, Math.max(40, nameW)))}</text>
${word ? `<text class="${r.status === 'failed' ? 'lv-bad' : 'mu'}" x="${barX - 10}" y="${y + 11}" text-anchor="end" font-family="${FONT}" font-size="10" font-weight="600">${word}</text>` : ''}
<rect class="trk" x="${barX}" y="${y + 4}" width="${barW}" height="6" rx="3"/>
${fill > 0 ? `<rect x="${barX}" y="${y + 4}" width="${Math.max(5, fill)}" height="6" rx="3" fill="url(#${r.status === 'done' ? 'gDone' : grad})"/>` : ''}
<text class="pc" x="${W - PAD}" y="${y + 11}" text-anchor="end" font-family="${FONT}" font-size="11" font-weight="700" font-variant-numeric="tabular-nums">${r.ctx}%</text>`
    })
    agentBlock = `<g>
<text class="mu" x="${PAD}" y="${ay + 10}" font-family="${FONT}" font-size="9.5" font-weight="700" letter-spacing=".9">${xml(head)}</text>
${rows.join('')}
</g>`
  }

  // Turn rail along the bottom: a travelling highlight while working.
  const railW = W - PAD * 2
  const seg = Math.round(railW * 0.28)
  keyframes.push(`@keyframes rl{0%{transform:translateX(${-seg}px)}100%{transform:translateX(${railW}px)}}`)
  const rail = `
<clipPath id="rc"><rect x="${PAD}" y="${H - 6}" width="${railW}" height="2" rx="1"/></clipPath>
<rect class="rail" x="${PAD}" y="${H - 6}" width="${railW}" height="2" rx="1"/>
${isRunning ? `<g clip-path="url(#rc)"><rect x="${PAD}" y="${H - 6}" width="${seg}" height="2" rx="1" fill="url(#gRail)" style="animation:rl 1.8s ${EASE} infinite;animation-delay:${phase(1.8)}"/></g>` : ''}`

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<style>${CSS}
${keyframes.join('\n')}
@media (prefers-reduced-motion: reduce){*{animation:none!important}}</style>
<defs>
<linearGradient id="gOk" x1="0" x2="1"><stop offset="0" stop-color="#FFBC25"/><stop offset="1" stop-color="#FFA500"/></linearGradient>
<linearGradient id="gWarn" x1="0" x2="1"><stop offset="0" stop-color="#EB6834"/><stop offset="1" stop-color="#F58A5B"/></linearGradient>
<linearGradient id="gBad" x1="0" x2="1"><stop offset="0" stop-color="#C62F2F"/><stop offset="1" stop-color="#E34948"/></linearGradient>
<linearGradient id="gDone" x1="0" x2="1"><stop offset="0" stop-color="#1F7A4D"/><stop offset="1" stop-color="#138A5E"/></linearGradient>
<linearGradient id="gNone" x1="0" x2="1"><stop offset="0" stop-color="#999"/><stop offset="1" stop-color="#bbb"/></linearGradient>
<linearGradient id="gSheen" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity=".55"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
<linearGradient id="gRail" x1="0" x2="1"><stop offset="0" stop-color="#FFA500" stop-opacity="0"/><stop offset=".5" stop-color="#FFA500"/><stop offset="1" stop-color="#FFBC25" stop-opacity="0"/></linearGradient>
</defs>
<rect class="card" x=".5" y=".5" width="${W - 1}" height="${H - 1}" rx="12"/>
${left}
${draw.join('')}
${taskRow}
${agentBlock}
${rail}
</svg>`
  return { svg, H }
}

// ---------------------------------------------------------------------------
// Agents pane: one card per subagent, in the monitor's design language.

const PANE_CSS = `${CSS}
.lz-ok{fill:#E3F5EB}.lz-okt{fill:#1F7A4D}.lz-bad{fill:#FDECEC}.lz-badt{fill:#C62F2F}.tile{fill:#EDF0F2}
.lz-att{fill:#FFF4D6}.lz-attt{fill:#8A5A00}
@media (prefers-color-scheme: dark){
.lz-ok{fill:#1E3A2C}.lz-okt{fill:#7BE0B0}.lz-bad{fill:#4A2323}.lz-badt{fill:#FF9C9A}.tile{fill:#333333}
.lz-att{fill:#4A3A12}.lz-attt{fill:#FFD36B}}`

const DEFS = `<defs>
<linearGradient id="gOk" x1="0" x2="1"><stop offset="0" stop-color="#FFBC25"/><stop offset="1" stop-color="#FFA500"/></linearGradient>
<linearGradient id="gWarn" x1="0" x2="1"><stop offset="0" stop-color="#EB6834"/><stop offset="1" stop-color="#F58A5B"/></linearGradient>
<linearGradient id="gBad" x1="0" x2="1"><stop offset="0" stop-color="#C62F2F"/><stop offset="1" stop-color="#E34948"/></linearGradient>
<linearGradient id="gDone" x1="0" x2="1"><stop offset="0" stop-color="#1F7A4D"/><stop offset="1" stop-color="#138A5E"/></linearGradient>
<linearGradient id="gSheen" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity=".55"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
</defs>`

const paneSvg = (W: number, H: number, extra: string, body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><style>${PANE_CSS}${extra}
@media (prefers-reduced-motion: reduce){*{animation:none!important}}</style>${DEFS}${body}</svg>`

const runElapsed = (a: Run, at: number): number => (a.endedAt ?? Math.max(at, a.startedAt)) - a.startedAt
const runContext = (a: Run): number => (a.contextMax ? Math.min(100, Math.round((a.contextTokens / a.contextMax) * 100)) : 0)

const LOZENGE: Record<Run['status'], { text: string; bg: string; fg: string }> = {
  running: { text: 'WORKING', bg: 'lz-run', fg: 'lz-runt' },
  done: { text: 'DONE', bg: 'lz-ok', fg: 'lz-okt' },
  failed: { text: 'FAILED', bg: 'lz-bad', fg: 'lz-badt' },
}

const statsSvg = (W: number, list: Run[], at: number): string => {
  const running = list.filter(a => a.status === 'running').length
  const tokens = list.reduce((s, a) => s + a.tokens, 0)
  const start = list.length ? Math.min(...list.map(a => a.startedAt)) : 0
  const end = list.length ? Math.max(...list.map(a => a.endedAt ?? Math.max(at, a.startedAt))) : 0
  const gap = 8
  const tw = Math.floor((W - gap * 2) / 3)
  const tile = (i: number, k: string, v: string): string => {
    const x = i * (tw + gap)
    return `<rect class="tile" x="${x}" y="0" width="${tw}" height="46" rx="8"/>
<text class="mu" x="${x + 12}" y="18" font-family="${FONT}" font-size="9.5" font-weight="700" letter-spacing=".9">${k}</text>
<text class="pc" x="${x + 12}" y="37" font-family="${FONT}" font-size="16" font-weight="700" font-variant-numeric="tabular-nums">${xml(v)}</text>`
  }
  return paneSvg(
    W,
    46,
    '',
    tile(0, 'RUNNING', `${running} / ${list.length}`) + tile(1, 'TOKENS', fmtTokens(tokens)) + tile(2, 'TIME', fmtTime(end - start)),
  )
}

const agentSvg = (W: number, a: Run, at: number, nowMs: number): string => {
  const H = 100
  const PAD = 14
  const lz = LOZENGE[a.status]
  const lzW = Math.round(textWidth(lz.text, 9.5) + 16 + lz.text.length * 0.6)
  const ctx = runContext(a)
  const typeText = a.type.replace(/^[^:]*:/, '')
  const chipW = Math.round(textWidth(typeText, 10) + 18)
  const meta = [
    modelName(a.model),
    a.effort ? a.effort : '',
    fmtTime(runElapsed(a, at)),
    `${fmtTokens(a.tokens)} tok`,
    `${a.steps} ${a.steps === 1 ? 'step' : 'steps'}`,
  ]
    .filter(Boolean)
    .join('  ·  ')
  const barW = W - PAD * 2
  const fillW = ctx > 0 ? Math.max(6, Math.round((barW * ctx) / 100)) : 0
  const lvl = ctx >= 85 ? 'CRITICAL' : ctx >= 60 ? 'HIGH' : ''
  const grad = ctx >= 85 ? 'gBad' : ctx >= 60 ? 'gWarn' : 'gOk'
  const dot = a.status === 'running' ? 'dot-run' : a.status === 'done' ? 'dot-ok' : 'lv-bad'
  const sheen = ''
  const kf = ''
  const body = `
<rect class="card" x=".5" y=".5" width="${W - 1}" height="${H - 1}" rx="12"/>
<circle class="${dot}" cx="${PAD + 5}" cy="${PAD + 11}" r="4"/>
<text class="nm" x="${PAD + 20}" y="${PAD + 15}" font-family="${FONT}" font-size="13" font-weight="650">${xml(fitText(a.description || a.type, 13, W - PAD * 2 - 20 - lzW - 12))}</text>
<rect class="${lz.bg}" x="${W - PAD - lzW}" y="${PAD + 3}" width="${lzW}" height="17" rx="8.5"/>
<text class="${lz.fg}" x="${W - PAD - lzW / 2}" y="${PAD + 15}" text-anchor="middle" font-family="${FONT}" font-size="9.5" font-weight="700" letter-spacing=".6">${lz.text}</text>
<rect class="chip" x="${PAD + 20}" y="${PAD + 27}" width="${chipW}" height="16" rx="8"/>
<text class="chipt" x="${PAD + 20 + chipW / 2}" y="${PAD + 38.5}" text-anchor="middle" font-family="${FONT}" font-size="10" font-weight="600">${xml(typeText)}</text>
<text class="mu" x="${PAD + 20 + chipW + 8}" y="${PAD + 39}" font-family="${FONT}" font-size="11" font-variant-numeric="tabular-nums">${xml(fitText(meta, 11, W - PAD * 2 - 20 - chipW - 8))}</text>
<text class="mu" x="${PAD}" y="${H - 30}" font-family="${FONT}" font-size="9.5" font-weight="700" letter-spacing=".9">CONTEXT${lvl ? `<tspan class="${ctx >= 85 ? 'lv-bad' : 'lv-hi'}" dx="5">${lvl}</tspan>` : ''}</text>
<text class="pc" x="${W - PAD}" y="${H - 30}" text-anchor="end" font-family="${FONT}" font-size="11" font-weight="700" font-variant-numeric="tabular-nums">${ctx}%  <tspan class="mu" font-weight="500">${fmtTokens(a.contextTokens)} of ${fmtTokens(a.contextMax)}</tspan></text>
<rect class="trk" x="${PAD}" y="${H - 24}" width="${barW}" height="6" rx="3"/>
${fillW ? `<rect x="${PAD}" y="${H - 24}" width="${fillW}" height="6" rx="3" fill="url(#${a.status === 'done' ? 'gDone' : grad})"/>` : ''}
${sheen}`
  return paneSvg(W, H, kf, body)
}

// ---------------------------------------------------------------------------
// Every session on this machine. Claude Code keeps a small registry entry per
// live session in ~/.claude/sessions/<pid>.json (name, folder, status, last
// update). Only that metadata is read: never transcripts, never the .key files.

const DEAD_AFTER_MS = 24 * 3600 * 1000

// Parsed registry and progress files, keyed by name and file time: a poll only reads
// the files that changed since the last one.
const regCache = new Map<string, { m: number; raw: Record<string, unknown> }>()
const progCache = new Map<string, { m: number; raw: Record<string, unknown> }>()

// An idle session that stopped recently is most likely waiting for you (a turn just
// finished); one that has been quiet for longer is background noise and is hidden.
// The registry only says busy or idle, so "needs you" is that recency, not a flag.
const ATTENTION_MS = 30 * 60 * 1000

const needsYou = (s: SessionRow, at: number): boolean => s.status === 'idle' && !s.isSelf && at - s.updatedAt <= ATTENTION_MS
const isShown = (s: SessionRow, at: number): boolean => s.isSelf || s.status === 'busy' || at - s.updatedAt <= ATTENTION_MS

const lastSegment = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() || p

// RTK (a CLI that condenses command output to save tokens), when it is installed.
// `rtk gain -f json` is a local read of its own history: no network, no tokens.
const fmtSaved = (n: number): string => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : `${Math.round(n)}`)

const parseRtk = (stdout: string): RtkScope | null => {
  try {
    const sum = (JSON.parse(stdout) as { summary?: Record<string, unknown> }).summary
    if (!sum) return null
    const saved = Number(sum.total_saved ?? 0)
    const input = Number(sum.total_input ?? 0)
    const pct = Number(sum.avg_savings_pct ?? (input > 0 ? (saved / input) * 100 : 0))
    return {
      saved,
      input,
      output: Number(sum.total_output ?? 0),
      commands: Number(sum.total_commands ?? 0),
      pct: Math.max(0, Math.min(100, pct)),
    }
  } catch {
    return null
  }
}

// Global savings, plus the savings of the session's own folder (`rtk gain --project`,
// run in the session's working directory) when RTK has recorded commands there.
async function readRtk($: EngineInterface): Promise<Rtk | null> {
  try {
    const all = await $.process.run(['rtk', 'gain', '-f', 'json'], { timeoutMs: 8000 })
    if (all.exitCode !== 0) return null
    const global = parseRtk(all.stdout)
    if (!global) return null
    let project: RtkScope | null = null
    try {
      const mine = await $.process.run(['rtk', 'gain', '--project', '-f', 'json'], { timeoutMs: 8000 })
      const parsed = mine.exitCode === 0 ? parseRtk(mine.stdout) : null
      project = parsed && parsed.commands > 0 ? parsed : null
    } catch {
      // No per-project reading: the global one still shows.
    }
    return { ...global, project }
  } catch {
    return null
  }
}

async function homeDir($: EngineInterface): Promise<string> {
  return ((await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || '').replace(/\\/g, '/')
}

// Each session publishes the progress of its own task to
// ~/.claude/live-status/progress/<sessionId>.json, so the others can draw it.
// Only the task's title, step counts and current step are written.
async function publishProgress($: EngineInterface): Promise<void> {
  try {
    const home = await homeDir($)
    if (!home) return
    const id = await $.session.id()
    const tv = taskView(await read($, task), await read($, crew))
    const at = await $.clock.now()
    const body = tv ? { title: tv.title, done: tv.done, total: tv.total, current: tv.current, isFinished: tv.isFinished, updatedAt: at } : { total: 0, updatedAt: at }
    await $.fs.write(`${home}/.claude/live-status/progress/${id}.json`, JSON.stringify(body))
  } catch {
    // Not writable: other sessions simply see no progress from this one.
  }
}

async function readProgress($: EngineInterface, home: string, id: string, at: number): Promise<SessionRow['task']> {
  try {
    const path = `${home}/.claude/live-status/progress/${id}.json`
    const st = await $.fs.stat(path)
    const hit = progCache.get(id)
    let raw: Record<string, unknown>
    if (hit && hit.m === st.mtimeMs) {
      raw = hit.raw
    } else {
      raw = JSON.parse((await $.fs.read(path)) as string) as Record<string, unknown>
      progCache.set(id, { m: st.mtimeMs, raw })
    }
    const total = Number(raw.total ?? 0)
    if (!(total > 0) || at - Number(raw.updatedAt ?? 0) > DEAD_AFTER_MS) return undefined
    return {
      title: typeof raw.title === 'string' ? raw.title : '',
      done: Math.max(0, Math.min(total, Number(raw.done ?? 0))),
      total,
      current: typeof raw.current === 'string' ? raw.current : '',
      isFinished: raw.isFinished === true,
    }
  } catch {
    return undefined
  }
}

const sessionSig = (rows: SessionRow[]): string =>
  JSON.stringify(rows.map(r => [r.id, r.status, r.updatedAt, r.name, r.task ? [r.task.done, r.task.total, r.task.current, r.task.isFinished] : 0]))

async function readSessions($: EngineInterface): Promise<SessionRow[]> {
  try {
    const home = await homeDir($)
    if (!home) return []
    const dir = `${home}/.claude/sessions`
    const entries = await $.fs.list(dir)
    const self = await $.session.id()
    const at = await $.clock.now()
    const rows: SessionRow[] = []
    for (const en of entries) {
      if (!/^\d+\.json$/.test(en.name)) continue
      try {
        const hit = regCache.get(en.name)
        let raw: Record<string, unknown>
        if (hit && hit.m === en.mtimeMs) {
          raw = hit.raw
        } else {
          raw = JSON.parse((await $.fs.read(`${dir}/${en.name}`)) as string) as Record<string, unknown>
          regCache.set(en.name, { m: en.mtimeMs, raw })
        }
        const id = typeof raw.sessionId === 'string' ? raw.sessionId : ''
        if (!id) continue
        const updatedAt = Number(raw.updatedAt ?? raw.statusUpdatedAt ?? raw.startedAt ?? 0)
        if (at - updatedAt > DEAD_AFTER_MS) continue
        const cwd = typeof raw.cwd === 'string' ? raw.cwd : ''
        rows.push({
          id,
          pid: Number(raw.pid ?? 0),
          name: typeof raw.name === 'string' && raw.name ? raw.name : lastSegment(cwd) || 'session',
          project: lastSegment(cwd),
          entry: typeof raw.entrypoint === 'string' ? raw.entrypoint.replace(/^claude-/, '') : 'cli',
          status: raw.status === 'busy' ? 'busy' : 'idle',
          updatedAt,
          startedAt: Number(raw.startedAt ?? 0),
          isSelf: id === self,
        })
      } catch {
        // A half-written or unreadable entry: skip it, the next poll gets it.
      }
    }
    for (const k of [...regCache.keys()]) if (!entries.some(en => en.name === k)) regCache.delete(k)
    for (const r of rows) {
      if (r.isSelf) continue
      const progress = await readProgress($, home, r.id, at)
      if (progress) r.task = progress
    }
    // This session first, then working ones, then the most recently active.
    return rows.sort(
      (a, b) =>
        Number(b.isSelf) - Number(a.isSelf) ||
        (a.status === b.status ? b.updatedAt - a.updatedAt : a.status === 'busy' ? -1 : 1),
    )
  } catch {
    return []
  }
}

const ago = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ago`
}

const sessionSvg = (W: number, s: SessionRow, at: number, nowMs: number): string => {
  void nowMs
  const H = 96
  const PAD = 14
  const busy = s.status === 'busy'
  const attention = needsYou(s, at)
  const lz = busy
    ? { text: 'WORKING', bg: 'lz-run', fg: 'lz-runt' }
    : attention
      ? { text: 'NEEDS YOU', bg: 'lz-att', fg: 'lz-attt' }
      : { text: 'IDLE', bg: 'lz-idle', fg: 'lz-idlet' }
  const lzW = Math.round(textWidth(lz.text, 9.5) + 16 + lz.text.length * 0.6)
  const thisW = s.isSelf ? Math.round(textWidth('THIS', 9) + 14) : 0
  const meta = `${s.entry} · ${s.project} · ${ago(at - s.updatedAt)}`
  const thisChip = s.isSelf
    ? `<rect class="chip" x="${W - PAD - lzW - thisW - 8}" y="${PAD + 4}" width="${thisW}" height="15" rx="7.5"/><text class="chipt" x="${W - PAD - lzW - thisW / 2 - 8}" y="${PAD + 15}" text-anchor="middle" font-family="${FONT}" font-size="9" font-weight="700" letter-spacing=".6">THIS</text>`
    : ''

  // Progress is the todo list that session keeps. A session that
  // reports none gets an empty bar and a plain note, never an invented percentage.
  const tk = s.task && s.task.total > 0 ? s.task : null
  const pct = tk ? Math.round((tk.done / tk.total) * 100) : 0
  const barW = W - PAD * 2
  const barY = H - 20
  const fillW = tk && pct > 0 ? Math.max(6, Math.round((barW * pct) / 100)) : 0
  const right = tk ? `${tk.done}/${tk.total}  ·  ${pct}%` : ''
  const head = tk
    ? `${tk.title}${tk.current && !tk.isFinished ? '  ›  ' + tk.current : ''}`
    : busy
      ? 'working · no task progress reported'
      : 'no task reported'
  const segs: string[] = []
  if (tk && tk.total <= 16) {
    for (let i = 1; i < tk.total; i++) {
      segs.push(`<rect class="seg" x="${PAD + Math.round((barW * i) / tk.total) - 1}" y="${barY}" width="2" height="6"/>`)
    }
  }
  const body = `
<rect class="card" x=".5" y=".5" width="${W - 1}" height="${H - 1}" rx="12"${s.isSelf ? ' style="stroke:#FFBC25"' : ''}/>
<circle class="${busy ? 'dot-run' : 'dot-ok'}" cx="${PAD + 5}" cy="${PAD + 11}" r="4"/>
<text class="nm" x="${PAD + 20}" y="${PAD + 15}" font-family="${FONT}" font-size="13" font-weight="650">${xml(fitText(s.name, 13, W - PAD * 2 - 20 - lzW - thisW - 20))}</text>
${thisChip}
<rect class="${lz.bg}" x="${W - PAD - lzW}" y="${PAD + 3}" width="${lzW}" height="17" rx="8.5"/>
<text class="${lz.fg}" x="${W - PAD - lzW / 2}" y="${PAD + 15}" text-anchor="middle" font-family="${FONT}" font-size="9.5" font-weight="700" letter-spacing=".6">${lz.text}</text>
<text class="mu" x="${PAD + 20}" y="${PAD + 38}" font-family="${FONT}" font-size="11" font-variant-numeric="tabular-nums">${xml(fitText(meta, 11, W - PAD * 2 - 20))}</text>
<text class="${tk ? 'nm' : 'mu'}" x="${PAD}" y="${H - 27}" font-family="${FONT}" font-size="10" font-weight="${tk ? 600 : 500}">${xml(fitText(head, 10, barW - (right ? textWidth(right, 11) + 16 : 0)))}</text>
${right ? `<text class="pc" x="${W - PAD}" y="${H - 27}" text-anchor="end" font-family="${FONT}" font-size="11" font-weight="700" font-variant-numeric="tabular-nums">${xml(right)}</text>` : ''}
<rect class="trk" x="${PAD}" y="${barY}" width="${barW}" height="6" rx="3"/>
${fillW ? `<rect x="${PAD}" y="${barY}" width="${fillW}" height="6" rx="3" fill="url(#${tk && tk.isFinished ? 'gDone' : 'gOk'})"/>` : ''}
${segs.join('')}`
  return paneSvg(W, H, '', body)
}

// A section header: caption left, summary right, and an overview progress bar.
const sectionSvg = (W: number, title: string, summary: string, pct: number | null, isDone = false): string => {
  const H = 38
  const fillW = pct === null ? 0 : Math.max(pct > 0 ? 6 : 0, Math.round((W * Math.min(100, pct)) / 100))
  const body = `
<text class="nm" x="0" y="14" font-family="${FONT}" font-size="10.5" font-weight="800" letter-spacing="1.2">${xml(title)}</text>
<text class="mu" x="${W}" y="14" text-anchor="end" font-family="${FONT}" font-size="11" font-weight="600" font-variant-numeric="tabular-nums">${xml(fitText(summary, 11, W - textWidth(title, 10.5) - 24))}</text>
<rect class="trk" x="0" y="22" width="${W}" height="7" rx="3.5"/>
${fillW ? `<rect x="0" y="22" width="${fillW}" height="7" rx="3.5" fill="url(#${isDone ? 'gDone' : 'gOk'})"/>` : ''}`
  return paneSvg(W, H, '', body)
}

async function togglePane($: EngineInterface): Promise<boolean> {
  const isOpen = (await $.ui.panes()).some(p => p.id === PANE)
  if (isOpen) {
    await $.ui.close({ id: PANE })
    return false
  }
  const at = await $.clock.now()
  await update($, now, () => at)
  await $.ui.open({ id: PANE, title: 'Agents' })
  return true
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await update($, now, () => 0)
    try {
      const m = await $.session.model()
      await update($, model, () => m)
    } catch {
      // The model shows up with the first step.
    }
    await $.command.register({
      name: 'monitor',
      description: 'Show or hide the whole monitor: the band above the prompt and the agents panel (on / off to force)',
    })
    await $.command.register({
      name: 'agents-live',
      description: 'Show or hide the panel of subagents: status, model, context, tokens and time',
    })
    await refresh($)
    const configured = await configuredEffort($)
    await update($, effort, cur => cur || configured)

    // On from the first moment: the band draws by itself; open the agents panel too.
    void $.ui.open({ id: PANE, title: 'Agents' })

    // Realtime: every second while a turn runs (clock, steps), every 5th second
    // re-reading usage mid-step; idle, every 15 seconds so reset countdowns and
    // limit windows stay true. Changes the engine reports arrive at once through
    // session.measure.
    let ticks = 0
    let lastSessionSig = ''
    let othersBusy = false
    // RTK: detected once; if it is not there nothing is drawn and nothing polls again.
    let rtkOn = false
    let rtkAt = 0
    const first = await readRtk($)
    rtkOn = first !== null
    await update($, rtk, () => first)
    // First read right away, so the panel is not empty for the first seconds.
    const firstRows = await readSessions($)
    lastSessionSig = sessionSig(firstRows)
    othersBusy = firstRows.some(r => !r.isSelf && r.status === 'busy')
    void publishProgress($)
    await update($, sessions, () => firstRows)
    $.clock.every(1000, () => {
      void (async () => {
        ticks += 1
        const t = await read($, turn)
        if (rtkOn && ticks - rtkAt >= 60) {
          rtkAt = ticks
          const fresh = await readRtk($)
          if (fresh) await update($, rtk, () => fresh)
        }
        // Cheap by design. Other sessions: polled every 5 s while something moves (a turn
        // here, or a working session elsewhere), every 15 s otherwise, and only files
        // that changed are read. The panel redraws on that slow clock. Usage is
        // re-read every 15 s, since the engine also reports changes by itself.
        const every = t.isRunning || othersBusy ? 5 : 15
        if (ticks % every === 0) {
          const rows = await readSessions($)
          othersBusy = rows.some(r => !r.isSelf && r.status === 'busy')
          const sig = sessionSig(rows)
          if (sig !== lastSessionSig) {
            lastSessionSig = sig
            await update($, sessions, () => rows)
          }
          const at = await $.clock.now()
          await update($, slow, () => at)
        }
        if (t.isRunning || ticks % 15 === 0) {
          if (ticks % 15 === 0) await refresh($)
          const at = await $.clock.now()
          await update($, now, () => at)
        }
      })()
    })

    return started
  })

  // Context, limits and cost move on their own: the engine reports each change.
  on('session.measure', async ($, e, next) => {
    await update($, usage, () => fromUsage(e))

    const worst = Math.max(e.context.percent ?? 0, ...e.rateLimits.map(r => r.percentUsed))
    const level = worst >= 95 ? '95' : worst >= 85 ? '85' : ''
    if (level && (await read($, warned)) !== level) {
      await update($, warned, () => level)
      $.ui.toast(`Usage at ${Math.round(worst)}%: see the monitor above the prompt`)
    } else if (!level) {
      await update($, warned, () => '')
    }

    return next(e)
  })

  // One command for both: the band above the prompt and the agents panel.
  on('command.run', { command: 'monitor' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const hidden = await read($, isHidden)
    const paneOpen = (await $.ui.panes()).some(p => p.id === PANE)
    const wantOn = arg === 'on' ? true : arg === 'off' ? false : hidden || !paneOpen

    if (wantOn) {
      await update($, isHidden, () => false)
      if (!paneOpen) await togglePane($)
      return { text: 'Monitor on: band and agents panel.' }
    }
    await update($, isHidden, () => true)
    if (paneOpen) await togglePane($)
    return { text: 'Monitor off.' }
  })

  on('command.run', { command: 'agents-live' }, async $ => {
    const isOpen = await togglePane($)
    return { text: isOpen ? 'Agents panel opened.' : 'Agents panel closed.' }
  })

  // Task progress comes from the todo list Claude already keeps (TodoWrite). The call is
  // only observed and passes through untouched, so this adds no tokens: no tool of our
  // own in the model's tool list, no extra calls, nothing written to its context.
  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId) return ran
    const todos = (e as unknown as { todos?: { content?: string; status?: string; activeForm?: string }[] }).todos ?? []
    const total = todos.length
    const done = todos.filter(t => t.status === 'completed').length
    const active = todos.find(t => t.status === 'in_progress') ?? todos.find(t => t.status === 'pending')
    await update($, task, () =>
      total > 0
        ? {
            title: 'Tasks',
            total,
            done,
            current: (active?.activeForm || active?.content || '').trim(),
            isFinished: done === total,
          }
        : null,
    )
    const at = await $.clock.now()
    await update($, now, () => at)
    await publishProgress($)
    return ran
  })

  on('turn.start', async ($, e, next) => {
    await update($, crew, () => ({ spawned: 0, done: 0 }))
    await publishProgress($)
    await update($, task, prev => (prev?.isFinished ? null : prev))
    const at = await $.clock.now()
    await update($, turn, t => ({ ...NO_TURN, isRunning: true, startedAt: at, agents: t.agents }))
    await update($, now, () => at)
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (!e.agentId) {
      await update($, model, () => e.model)
      await update($, effort, () => (e.effort === undefined ? '' : String(e.effort)))
      await update($, turn, t => ({ ...t, steps: t.steps + 1 }))
    }
    const result = yield* next(e)
    const u = result.usage
    const agentId = e.agentId
    if (agentId && u) {
      // A subagent's own request: its live context, tokens and step count.
      const used =
        (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0)
      await update($, runs, list =>
        list.map(r =>
          r.agentId !== agentId
            ? r
            : {
                ...r,
                model: u.model || e.model,
                effort: typeof e.effort === 'string' ? e.effort : r.effort,
                status: 'running' as const,
                endedAt: undefined,
                contextTokens: used,
                contextMax: /haiku/i.test(u.model || e.model) ? 200_000 : 1_000_000,
                tokens: r.tokens + used,
                steps: r.steps + 1,
              },
        ),
      )
    }
    await refresh($)
    return result
  })

  on('tool.call', async ($, e, next) => {
    if (!e.agentId) await update($, turn, t => ({ ...t, tools: t.tools + 1 }))
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (started.deny === undefined) {
      await update($, turn, t => ({ ...t, agents: t.agents + 1 }))
      await update($, crew, c => ({ ...c, spawned: c.spawned + 1 }))
      await publishProgress($)
      const at = await $.clock.now()
      await update($, runs, list => {
        const run: Run = {
          id: started.agentId ?? e.tool_use_id,
          agentId: started.agentId,
          type: e.subagentType,
          description: e.description,
          model: started.model,
          status: 'running',
          startedAt: at,
          contextTokens: 0,
          contextMax: /haiku/i.test(started.model) ? 200_000 : 1_000_000,
          tokens: 0,
          steps: 0,
        }
        return [...list.filter(r => r.id !== run.id), run].slice(-40)
      })
      await update($, now, () => at)
    }
    return started
  })

  on('turn.complete', async ($, e, next) => {
    const at = await $.clock.now()
    if (e.agentId) {
      await update($, turn, t => ({ ...t, agents: Math.max(0, t.agents - 1) }))
      await update($, crew, c => ({ ...c, done: Math.min(c.spawned, c.done + 1) }))
      await publishProgress($)
      const agentId = e.agentId
      await update($, runs, list =>
        list.map(r => (r.agentId === agentId ? { ...r, status: e.reason === 'answer' ? ('done' as const) : ('failed' as const), endedAt: at } : r)),
      )
    } else {
      await update($, turn, t => ({
        ...t,
        isRunning: false,
        lastSeconds: Math.round((at - t.startedAt) / 1000),
        agents: 0,
      }))
    }
    await refresh($)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const list = await read($, runs)
    const p: Panel = await read($, panel)
    const nowMs = await $.clock.now()
    await read($, slow) // the panel redraws on this slow clock, not every second
    const at = nowMs
    const running = list.filter(r => r.status === 'running').reverse()
    const finished = list.filter(r => r.status !== 'running').reverse()
    const rtkInfo = await read($, rtk)
    const everySession = await read($, sessions)
    const own = taskView(await read($, task), await read($, crew))
    const sessionList = everySession
      .filter(s => isShown(s, nowMs))
      .map(s => (s.isSelf && own ? { ...s, task: { title: own.title, done: own.done, total: own.total, current: own.current, isFinished: own.isFinished } } : s))
    const sessionsHidden = everySession.length - sessionList.length
    const sessionsWorking = sessionList.filter(s => s.status === 'busy').length
    const sessionsNeed = sessionList.filter(s => needsYou(s, nowMs)).length

    const toggleCompact = (
      <Button
        key="compact"
        label={p.isCompact ? 'Expand' : 'Collapse'}
        plain
        onPress={() => update($, panel, prev => ({ ...prev, isCompact: !prev.isCompact }))}
      />
    )
    const toggleDone = (
      <Button
        key="done"
        label={`${p.isDoneCollapsed ? '▸' : '▾'} Finished · ${finished.length}`}
        plain
        onPress={() => update($, panel, prev => ({ ...prev, isDoneCollapsed: !prev.isDoneCollapsed }))}
      />
    )

    if ('Svg' in ui) {
      const { Svg } = ui
      const W = Math.max(240, Math.min(900, (e.props.bodyColumns || 40) * 8 - 8))
      const card = (r: Run) => (
        <Svg
          key={r.id}
          source={agentSvg(W, r, at, nowMs)}
          alt={`${r.description || r.type}: ${r.status}, ${modelName(r.model)}, context ${runContext(r)}%`}
          width={W}
          height={100}
        />
      )
      return (
        <Box flexDirection="column" gap={1}>
          <Svg
            source={statsSvg(W, list, at)}
            alt={`${running.length} of ${list.length} agents running, ${fmtTokens(list.reduce((s, r) => s + r.tokens, 0))} tokens`}
            width={W}
            height={46}
          />
          {toggleCompact}
          {rtkInfo?.project && !p.isCompact && (
            <Svg
              source={sectionSvg(W, 'RTK · THIS PROJECT', `${fmtSaved(rtkInfo.project.saved)} saved · ${rtkInfo.project.commands} commands · ${Math.round(rtkInfo.project.pct)}%`, rtkInfo.project.pct, true)}
              alt={`RTK in this project: ${fmtSaved(rtkInfo.project.saved)} tokens saved over ${rtkInfo.project.commands} commands, ${Math.round(rtkInfo.project.pct)} percent`}
              width={W}
              height={38}
            />
          )}
          {rtkInfo && !p.isCompact && (
            <Svg
              source={sectionSvg(W, 'RTK · ALL PROJECTS', `${fmtSaved(rtkInfo.saved)} saved · ${rtkInfo.commands} commands · ${Math.round(rtkInfo.pct)}%`, rtkInfo.pct, true)}
              alt={`RTK overall: ${fmtSaved(rtkInfo.saved)} tokens saved over ${rtkInfo.commands} commands, ${Math.round(rtkInfo.pct)} percent`}
              width={W}
              height={38}
            />
          )}
          {!p.isCompact && (
            <Svg
              source={sectionSvg(W, 'SESSIONS', `${sessionsWorking} working${sessionsNeed ? ` · ${sessionsNeed} need you` : ''}${sessionsHidden ? ` · ${sessionsHidden} idle hidden` : ''}`, sessionList.length ? (sessionsWorking / sessionList.length) * 100 : null)}
              alt={`Sessions: ${sessionsWorking} of ${sessionList.length} working, ${sessionsNeed} need you, ${sessionsHidden} idle hidden`}
              width={W}
              height={38}
            />
          )}
          {!p.isCompact && sessionList.length === 0 && <Text dimColor>No sessions found yet.</Text>}
          {!p.isCompact &&
            sessionList.map(s => (
              <Svg
                key={s.id}
                source={sessionSvg(W, s, nowMs, nowMs)}
                alt={`${s.name}${s.isSelf ? ' (this session)' : ''}: ${s.status === 'busy' ? 'working' : 'idle'}, ${s.project}, updated ${ago(nowMs - s.updatedAt)}`}
                width={W}
                height={96}
              />
            ))}
          {!p.isCompact && (
            <Svg
              source={sectionSvg(W, 'SUBAGENTS', list.length ? `${finished.length} / ${list.length} finished` : 'none yet', list.length ? (finished.length / list.length) * 100 : null, list.length > 0 && running.length === 0)}
              alt={`Subagents: ${finished.length} of ${list.length} finished`}
              width={W}
              height={38}
            />
          )}
          {list.length === 0 && <Text dimColor>No subagents yet. They show up here the moment one starts.</Text>}
          {!p.isCompact && running.length > 0 && <Text dimColor>Working · {running.length}</Text>}
          {!p.isCompact && running.map(card)}
          {!p.isCompact && finished.length > 0 && toggleDone}
          {!p.isCompact && !p.isDoneCollapsed && finished.slice(0, 8).map(card)}
        </Box>
      )
    }

    // Terminal: the same rows in text.
    const cols = Math.max(24, e.props.bodyColumns || 40)
    const w = Math.max(6, Math.min(20, cols - 30))
    const row = (r: Run) => {
      const ctx = runContext(r)
      return (
        <Box key={r.id} flexDirection="column" marginBottom={1}>
          <Text bold wrap="truncate-end">
            <Text color={r.status === 'failed' ? RED : r.status === 'done' ? GREEN : BLUE}>
              {r.status === 'running' ? '●' : r.status === 'done' ? '✓' : '✗'}{' '}
            </Text>
            {r.description || r.type}
          </Text>
          <Text dimColor wrap="truncate-end">
            {'  '}
            {r.type.replace(/^[^:]*:/, '')} · {modelName(r.model)}
            {r.effort ? ` · ${r.effort}` : ''} · {fmtTime(runElapsed(r, at))} · {fmtTokens(r.tokens)} tok
          </Text>
          <Text wrap="truncate-end">
            {'  '}
            <Text color={tone(ctx)}>{bar(ctx, w)}</Text>
            <Text dimColor>
              {' '}
              ctx {ctx}% · {fmtTokens(r.contextTokens)}
            </Text>
          </Text>
        </Box>
      )
    }
    return (
      <Box flexDirection="column">
        <Text dimColor>
          {running.length}/{list.length} running · {fmtTokens(list.reduce((s, r) => s + r.tokens, 0))} tokens
        </Text>
        {toggleCompact}
        {!p.isCompact && sessionList.length > 0 && (
          <Text dimColor>
            sessions · {sessionsWorking}/{sessionList.length} working{sessionsNeed ? ` · ${sessionsNeed} need you` : ''}{sessionsHidden ? ` · ${sessionsHidden} hidden` : ''}{' '}
            {bar(sessionList.length ? (sessionsWorking / sessionList.length) * 100 : 0, 10)}
          </Text>
        )}
        {!p.isCompact &&
          sessionList.map(s => (
            <Text key={s.id} wrap="truncate-end">
              <Text color={s.status === 'busy' ? BLUE : needsYou(s, nowMs) ? AMBER : GREEN}>{s.status === 'busy' ? '●' : needsYou(s, nowMs) ? '!' : '○'} </Text>
              {s.name}
              <Text dimColor>
                {' '}
                {s.isSelf ? '(this) ' : ''}· {s.project} · {ago(nowMs - s.updatedAt)}
              </Text>
            </Text>
          ))}
        {!p.isCompact && list.length > 0 && (
          <Text dimColor>
            subagents · {finished.length}/{list.length} finished {bar((finished.length / list.length) * 100, 10)}
          </Text>
        )}
        {list.length === 0 && <Text dimColor>No subagents yet.</Text>}
        {!p.isCompact && running.map(row)}
        {!p.isCompact && finished.length > 0 && toggleDone}
        {!p.isCompact && !p.isDoneCollapsed && finished.slice(0, 8).map(row)}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isHidden))) return next(e)

    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const u = await read($, usage)
    const rtkInfo = await read($, rtk)
    const rtkView = rtkInfo ? (rtkInfo.project ?? rtkInfo) : null
    const t = await read($, turn)
    const at = (await read($, now)) || (await $.clock.now())
    const m = await read($, model)
    const fx = await read($, effort)
    const tv = taskView(await read($, task), await read($, crew))
    const runList = await read($, runs)
    const shownAt = await $.clock.now()
    const allSessions = (await read($, sessions)).filter(s => isShown(s, shownAt))
    const sessionSummary = {
      total: allSessions.length,
      working: allSessions.filter(s => s.status === 'busy').length,
      attention: allSessions.filter(s => needsYou(s, shownAt)).length,
    }
    const crewCount = runList.length

    // Agents go inline when the panel has no room (narrow window) or is not open.
    let paneOpen = false
    try {
      paneOpen = (await $.ui.panes()).some(p => p.id === PANE)
    } catch {
      // Treat as closed: the inline rows are the safe fallback.
    }
    const needInline = runList.length > 0 && (!paneOpen || (e.props.bodyColumns || 100) < 144)
    const maxRows = (e.props.bodyColumns || 100) < 70 ? 2 : 3
    const ordered = [...runList.filter(r => r.status === 'running').reverse(), ...runList.filter(r => r.status !== 'running').reverse()]
    const inline = {
      rows: needInline
        ? ordered.slice(0, maxRows).map((r): AgentRow => ({ name: r.description || r.type, status: r.status, ctx: runContext(r) }))
        : [],
      working: runList.filter(r => r.status === 'running').length,
      more: needInline ? Math.max(0, ordered.length - maxRows) : 0,
    }
    const cols = e.props.bodyColumns || 100
    const ctx = u.ctxPercent

    const elapsed = t.isRunning ? fmtTime(at - t.startedAt) : t.lastSeconds ? fmtTime(t.lastSeconds * 1000) : ''
    const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`
    const state = t.isRunning ? 'Working' : 'Idle'
    const detail = t.isRunning
      ? `${elapsed} · ${plural(t.steps, 'step')} · ${plural(t.tools, 'tool')}${t.agents ? ` · ${plural(t.agents, 'agent')}` : ''}`
      : t.lastSeconds
        ? `last turn ${elapsed} · ${plural(t.steps, 'step')}`
        : 'waiting for a prompt'
    const status = `${state} · ${detail}`

    const dismiss = <Button key="hide" label="✕" plain role="dismiss" onPress={() => update($, isHidden, () => true)} />

    if ('Svg' in ui) {
      const { Svg } = ui
      const W = Math.max(300, Math.min(1100, cols * 8 - 56))
      const gauges: Gauge[] = [
        {
          label: 'CONTEXT',
          pct: ctx,
          caption: u.ctxTokens !== null && u.ctxWindow ? `${fmtTokens(u.ctxTokens)} of ${fmtTokens(u.ctxWindow)}` : 'no reading',
          sheen: true,
        },
        ...u.limits.map(
          (l): Gauge => ({
            label: LIMIT_LABEL[l.kind] ?? l.kind.toUpperCase(),
            pct: l.pct,
            caption: l.resetsAt ? `resets in ${fmtReset(l.resetsAt, at)}` : 'resets unknown',
            sheen: false,
          }),
        ),
        ...(rtkView
          ? [{ label: rtkInfo?.project ? 'RTK PROJECT' : 'RTK SAVED', pct: Math.round(rtkView.pct), caption: `${fmtSaved(rtkView.saved)} saved · ${rtkView.commands}`, sheen: false, good: true } as Gauge]
          : []),
      ]
      const { svg, H } = cardSvg({
        W,
        stack: shouldStack(W, gauges),
        name: m ? modelName(m) : 'Claude',
        fx,
        cost: u.costUsd !== null ? fmtCost(u.costUsd) : '',
        state,
        detail,
        isRunning: t.isRunning,
        gauges,
        task: tv,
        agents: inline,
        sessions: sessionSummary,
        nowMs: await $.clock.now(),
      })
      const alt =
        `${m ? modelName(m) : 'Claude'}${fx ? `, effort ${fx}` : ''}; ${status}; ` +
        (tv ? `task ${tv.title} ${tv.done} of ${tv.total}, ${Math.round((tv.done / Math.max(1, tv.total)) * 100)}%; ` : '') +
        gauges.map(g => `${g.label} ${g.pct === null ? 'no reading' : Math.round(g.pct) + '%'}`).join(', ')
      return (
        <Box flexDirection="row" alignItems="center" gap={1}>
          <Svg source={svg} alt={alt} width={W} height={H} />
          {crewCount > 0 ? <Button key="agents" label={`agents ×${crewCount}`} plain onPress={() => void togglePane($)} /> : null}
          {dismiss}
        </Box>
      )
    }

    // Terminal: the same figures in text rows.
    const w = cols < 70 ? 6 : 10
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={2}>
          <Text bold color={BLUE}>
            {t.isRunning ? '◉' : '○'} {m ? modelName(m) : '...'}
            {' · '}
            {fx || 'effort ?'}
          </Text>
          {ctx !== null ? (
            <Text>
              <Text dimColor>ctx </Text>
              <Text color={tone(ctx)}>{bar(ctx, w)}</Text>
              <Text bold> {ctx}%</Text>
              {u.ctxTokens !== null && u.ctxWindow ? (
                <Text dimColor>
                  {' '}
                  {fmtTokens(u.ctxTokens)}/{fmtTokens(u.ctxWindow)}
                </Text>
              ) : null}
            </Text>
          ) : (
            <Text dimColor>ctx --</Text>
          )}
          {u.costUsd !== null ? <Text dimColor>{fmtCost(u.costUsd)}</Text> : null}
          {dismiss}
        </Box>
        <Box flexDirection="row" gap={2}>
          {u.limits.length === 0 ? (
            <Text dimColor>limits: no reading yet</Text>
          ) : (
            u.limits.map(l => (
              <Text key={l.kind}>
                <Text dimColor>{(LIMIT_LABEL[l.kind] ?? l.kind).toLowerCase()} </Text>
                <Text color={tone(l.pct)}>{bar(l.pct, w)}</Text>
                <Text bold> {Math.round(l.pct)}%</Text>
                {l.resetsAt ? <Text dimColor> ↻{fmtReset(l.resetsAt, at)}</Text> : null}
              </Text>
            ))
          )}
          <Text color={t.isRunning ? AMBER : undefined} dimColor={!t.isRunning}>
            {status}
          </Text>
          {rtkView ? (
            <Text>
              <Text dimColor>{rtkInfo?.project ? 'rtk project ' : 'rtk '}</Text>
              <Text color={GREEN}>{bar(rtkView.pct, w)}</Text>
              <Text bold> {Math.round(rtkView.pct)}%</Text>
              <Text dimColor> {fmtSaved(rtkView.saved)} saved</Text>
            </Text>
          ) : null}
        </Box>
        {tv ? (
          <Box flexDirection="row" gap={2}>
            <Text dimColor wrap="truncate-end">
              task {tv.title}
              {tv.current && !tv.isFinished ? ` › ${tv.current}` : ''}
            </Text>
            <Text color={tv.isFinished ? GREEN : AMBER}>{bar((tv.done / Math.max(1, tv.total)) * 100, w * 2)}</Text>
            <Text bold>
              {tv.done}/{tv.total} · {Math.round((tv.done / Math.max(1, tv.total)) * 100)}%
            </Text>
          </Box>
        ) : null}
        {inline.rows.length > 0 ? (
          <Box flexDirection="column">
            <Text dimColor>
              agents · {inline.working} working{inline.more ? ` · +${inline.more} more` : ''}
            </Text>
            {inline.rows.map(r => (
              <Text key={r.name + r.status} wrap="truncate-end">
                <Text color={r.status === 'failed' ? RED : r.status === 'done' ? GREEN : BLUE}>
                  {r.status === 'running' ? '●' : r.status === 'done' ? '✓' : '✗'}{' '}
                </Text>
                {r.name} <Text color={tone(r.ctx)}>{bar(r.ctx, 8)}</Text> {r.ctx}%
              </Text>
            ))}
          </Box>
        ) : null}
      </Box>
    )
  })
}
