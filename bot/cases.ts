import { z } from 'zod';
import { Step } from './transformer';

// The agent only returns data. Everything below checks that data against the AST before the builder renders it.
export const MATCHERS = ['toBe', 'toEqual', 'toStrictEqual', 'toMatchObject', 'toHaveProperty', 'toHaveLength', 'toContain',
    'toBeNull', 'toBeUndefined', 'toBeDefined', 'toBeTruthy', 'toBeFalsy', 'toBeNaN', 'toBeGreaterThan', 'toBeLessThan',
    'toBeCloseTo', 'toMatch'] as const

export const MAX_CASES = 8
const MAX_JSON = 4000

const Mock = z.object({ returns: z.unknown().optional(), resolves: z.unknown().optional(), throws: z.string().max(80).optional() })

const Case = z.object({
    name: z.string().min(1).max(120),
    why: z.string().max(240).optional(),
    args: z.record(z.string(), z.unknown()).default({}),
    mocks: z.record(z.string(), Mock).default({}),
    expect: z.union([
        z.object({ matcher: z.enum(MATCHERS), args: z.array(z.unknown()).max(3).default([]) }),
        z.object({ throws: z.union([z.string().max(120), z.literal(true)]) }),
    ]),
})
export type AgentCase = z.infer<typeof Case>
export type Plan = Map<string, AgentCase[]>

// JSON cannot express Date / undefined / long strings, so the agent uses small markers instead.
export function revive(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(revive)
    if (v && typeof v === 'object') {
        const o = v as Record<string, unknown>
        if ('$undefined' in o) return undefined
        if (typeof o.$date === 'string') return new Date(o.$date)
        if (Array.isArray(o.$repeat) && typeof o.$repeat[0] === 'string' && o.$repeat[0].length <= 20 && Number.isInteger(o.$repeat[1])
            && o.$repeat[1] >= 0 && o.$repeat[1] <= 5000) return o.$repeat[0].repeat(o.$repeat[1])
        return Object.fromEntries(Object.entries(o).filter(([k]) => k !== '__proto__').map(([k, x]) => [k, revive(x)]))
    }
    return v
}

const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)

// Agent values override the sampled base value; objects are merged so the agent can send only the fields it cares about.
export function mergeInput(base: unknown, over: unknown): unknown {
    if (!isPlain(base) || !isPlain(over)) return over
    const out: Record<string, unknown> = { ...base }
    for (const [k, v] of Object.entries(over)) out[k] = k in base ? mergeInput(base[k], v) : v
    return out
}

export function allCalls(steps: Step[] = []): Step[] {
    return steps.flatMap(s => [...(s.kind === 'call' ? [s] : []), ...allCalls(s.children), ...allCalls(s.else), ...allCalls(s.catch), ...allCalls(s.finally)])
}

// Keep only cases that match real parameters and mockable calls of the function; report the rest.
export function parsePlan(raw: unknown, fns: Step[], mockable: (fn: Step) => Set<string>, notes: string[] = []): Plan {
    const plan: Plan = new Map()
    const byName = new Map(fns.map(f => [f.value, f]))
    const functions = (raw as { functions?: unknown })?.functions
    if (!isPlain(functions)) { notes.push('plan has no "functions" object'); return plan }

    for (const [name, list] of Object.entries(functions)) {
        const fn = byName.get(name)
        if (!fn || !Array.isArray(list)) { notes.push(`ignored unknown function "${name}"`); continue }
        const params = new Set(fn.params ?? [])
        const callees = mockable(fn)
        const ok: AgentCase[] = []
        for (const item of list.slice(0, MAX_CASES)) {
            const parsed = Case.safeParse(item)
            if (!parsed.success) { notes.push(`${name}: invalid case (${parsed.error.issues[0]?.message})`); continue }
            const c = parsed.data
            const bad = Object.keys(c.args).find(k => !params.has(k)) ?? Object.keys(c.mocks).find(k => !callees.has(k))
            if (bad) { notes.push(`${name}: "${c.name}" references unknown "${bad}"`); continue }
            if (JSON.stringify(c).length > MAX_JSON) { notes.push(`${name}: "${c.name}" too large`); continue }
            ok.push(c)
        }
        if (ok.length) plan.set(name, ok)
    }
    return plan
}
