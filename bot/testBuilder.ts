import * as fs from 'fs';
import * as path from 'path';
import { TestGenerator, Step } from './transformer';
import { loadJestDocs, JestDoc } from './jestDocs';
import { tagFunction, Tag, LITERAL, findDoc } from './tagger';
import { collectInputs, CollectOptions, InputFactory, applyConditions, toLiteral, Param } from './inputs';
import { AgentCase, Plan, allCalls, mergeInput, revive } from './cases';

const MAX_SCENARIOS = 12

export interface Scenario {
    conds: string[];
    calls: { step: Step; awaited: boolean }[];
    outcome?: Step;   // return / throw that ends the path; undefined = falls off the end
}

// Every distinct path through a function body (branches fork, loops run 0 or 1 times), capped.
export function expand(steps: Step[], start: Scenario): Scenario[] {
    const done: Scenario[] = []
    let open: Scenario[] = [start]

    steps.forEach((s, i) => {
        const next: Scenario[] = []
        const fork = (c: Scenario, cond: string | undefined, body: Step[]) => {
            for (const sub of expand(body, { ...c, conds: cond ? [...c.conds, cond] : c.conds })) {
                ;(sub.outcome ? done : next).push(sub)
            }
        }

        for (const c of open) {
            if (s.kind === 'call') {
                next.push({ ...c, calls: [...c.calls, { step: s, awaited: steps[i + 1]?.kind === 'await' }] })
            } else if (s.kind === 'return' || s.kind === 'throw') {
                done.push({ ...c, outcome: s })
            } else if (s.kind === 'branch' && s.value.startsWith('switch')) {
                s.children.forEach(cs => fork(c, `${s.value.slice(7, -1)} matches ${cs.value}`, cs.children))
            } else if (s.kind === 'branch') {
                fork(c, s.value, s.children)
                fork(c, /^!\w[\w.]*$/.test(s.value) ? s.value.slice(1) : `!(${s.value})`, s.else ?? [])
            } else if (s.kind === 'try') {
                fork(c, undefined, s.children)
                fork(c, 'a dependency throws', s.catch ?? [])
            } else if (s.kind === 'loop') {
                const of = s.value.match(/\bof\s+(.+)\)\s*$/)?.[1]
                fork(c, of ? `${of}.length > 0` : undefined, s.children)
                next.push({ ...c, conds: [...c.conds, of ? `${of}.length === 0` : `${s.value} does not iterate`] })
            } else {
                next.push(c)
            }
        }
        open = next.slice(0, MAX_SCENARIOS)
    })
    return [...done, ...open].slice(0, MAX_SCENARIOS)
}

// identifier -> module specifier, from the file's import steps
function importMap(steps: Step[]): Map<string, string> {
    const map = new Map<string, string>()
    for (const s of steps) {
        if (s.declType !== 'import') continue
        const mod = s.value.match(/from\s+['"]([^'"]+)['"]/)?.[1]
        if (!mod) continue
        const clause = s.value.replace(/^import\s+(type\s+)?/, '').replace(/\s+from\s+.*$/, '')
        const named = clause.match(/\{([^}]*)\}/)?.[1] ?? ''
        named.split(',').map(n => n.trim()).filter(Boolean).forEach(n => map.set(n.split(/\s+as\s+/).pop()!, mod))
        const rest = clause.replace(/\{[^}]*\}/, '').replace(/,/g, ' ').trim()
        rest.split(/\s+/).filter(Boolean).forEach(n => { if (n !== '*' && n !== 'as') map.set(n, mod) })
    }
    return map
}

const ALLOWED = new Set(['true', 'false', 'null', 'undefined', 'new', 'Error', 'TypeError', 'Date', 'Math', 'JSON',
    'Number', 'String', 'Boolean', 'Object', 'Array', 'p', 'k'])

// true when the expression only uses params and literals, i.e. can be pasted into the test as-is
function assertable(expr: string, params: string[]): boolean {
    if (/\bawait\b|=>|\bfunction\b|\?|<fn>/.test(expr)) return false
    const stripped = expr
        .replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '""')
        .replace(/\.\s*[A-Za-z_$][\w$]*/g, '.p')
        .replace(/[A-Za-z_$][\w$]*\s*:/g, 'k:')
    return (stripped.match(/[A-Za-z_$][\w$]*/g) ?? []).every(i => params.includes(i) || ALLOWED.has(i))
}


const baseValues = (fn: Step, factory?: InputFactory): Param[] =>
    (fn.params ?? []).map((p, i) => ({ name: p, ...(factory?.forType(fn.paramTypes?.[i] ?? '', p) ?? { value: undefined }) }))

function emitParams(fn: Step, values: Param[], out: string[]) {
    values.forEach((p, i) => {
        if (p.value === undefined) {
            out.push(`      const ${p.name}: any = undefined; // TODO: value for ${p.name}`)
        } else {
            const cast = p.value && typeof p.value === 'object' && !(p.value instanceof Date) ? ` as Parameters<typeof ${fn.value}>[${i}]` : ''
            out.push(`      const ${p.name} = ${toLiteral(p.value)}${cast};`)
        }
    })
}

function isMockable(step: Step, imports: Map<string, string>): boolean {
    const callee = step.callee ?? ''
    if (callee.startsWith('new ') || !(step.coreAction === 'api_call' || step.coreAction === 'db_save' || step.isExternal)) return false
    return imports.has(callee.split('.')[0]) || (step.coreAction === 'api_call' && /^\w+$/.test(callee))
}

function mockTarget(callee: string, imports: Map<string, string>): string {
    const root = callee.split('.')[0]
    if (callee === root && imports.has(root)) return `jest.mocked(${callee})`
    if (imports.has(root)) return `jest.spyOn(${callee.slice(0, callee.lastIndexOf('.'))}, '${callee.slice(callee.lastIndexOf('.') + 1)}' as never)`
    return `jest.spyOn(globalThis as any, '${callee}')`
}

function renderScenario(fn: Step, sc: Scenario, tagOf: Map<Step, Tag>, imports: Map<string, string>, factory?: InputFactory): string {
    const params = fn.params ?? []
    const isAsync = !!fn.async
    const out: string[] = []
    const call = `${fn.value}(${params.join(', ')})`
    const out_ = sc.outcome
    const kind = out_?.kind === 'throw' ? 'throws' : out_?.kind === 'return' ? 'returns' : 'completes'
    const full = `${kind}${sc.conds.length ? ` when ${sc.conds.join(' and ')}` : ''}`
    const title = full.length > 110 ? `${full.slice(0, 107)}...` : full

    // inputs: real/sampled values first, then adjusted so this scenario's conditions hold
    const values = baseValues(fn, factory)
    const unsolved = factory ? applyConditions(sc.conds, values, factory.src) : sc.conds
    const ignorable = (c: string) => /a dependency throws|does not iterate/.test(c)

    out.push(`    test(${JSON.stringify(title)}, ${isAsync ? 'async ' : ''}() => {`)
    emitParams(fn, values, out)
    unsolved.filter(c => !ignorable(c)).forEach(c => out.push(`      // TODO: arrange inputs/mocks so that: ${c.replace(/\*\//g, '')}`))
    if (unsolved.some(c => /a dependency throws/.test(c))) out.push('      // TODO: make a mocked dependency throw so the catch path runs')

    const mocked = sc.calls.filter(({ step }) => isMockable(step, imports))
    for (const { step, awaited } of mocked) {
        out.push(`      ${mockTarget(step.callee!, imports)}.${awaited ? 'mockResolvedValue' : 'mockReturnValue'}(undefined as never); // TODO: stub result`)
    }

    out.push('')
    if (out_?.kind === 'throw') {
        const msg = out_.value.match(/^new \w*Error\((.*)\)$/)?.[1] ?? ''
        const arg = msg && assertable(msg, params) ? msg : ''
        out.push(isAsync
            ? `      await expect(${call}).rejects.toThrow(${arg});`
            : `      expect(() => ${call}).toThrow(${arg});`)
    } else {
        out.push(`      const result = ${isAsync ? 'await ' : ''}${call};`)
        const tag = out_ && tagOf.get(out_)
        const matcher = tag?.matchers[0] ?? 'toBeUndefined'
        const value = out_?.value ?? ''
        if (matcher === 'toBeUndefined' || matcher === 'toBeNull') {
            out.push(`      expect(result).${matcher}();`)
        } else if (LITERAL.test(value) || assertable(value, params)) {
            out.push(`      expect(result).${matcher}(${value});`)
        } else {
            // value depends on intermediate state - record current behaviour instead of guessing
            out.push(`      expect(result).toMatchSnapshot(); // characterises: ${value.replace(/\*\//g, '').slice(0, 80)}`)
        }
    }

    for (const { step } of mocked) {
        const args = step.args ?? []
        out.push(args.every(a => assertable(a, params))
            ? `      expect(${step.callee}).toHaveBeenCalledWith(${args.join(', ')});`
            : `      expect(${step.callee}).toHaveBeenCalled(); // TODO: args depend on intermediate values: (${(step.args ?? []).join(', ').replace(/\*\//g, '')})`)
    }
    out.push('    });')
    return out.join('\n')
}

// A test from an agent-proposed edge case: its args override the sampled inputs, its mocks replace the TODO stubs.
function renderCase(fn: Step, c: AgentCase, imports: Map<string, string>, factory?: InputFactory): string {
    const params = fn.params ?? []
    const call = `${fn.value}(${params.join(', ')})`
    const values = baseValues(fn, factory).map(p => p.name in c.args ? { ...p, value: mergeInput(p.value, revive(c.args[p.name])) } : p)
    const out = [`    test(${JSON.stringify(`[agent] ${c.name}`)}, ${fn.async ? 'async ' : ''}() => {`]
    if (c.why) out.push(`      // ${c.why.replace(/\s+/g, ' ')}`)
    emitParams(fn, values, out)

    for (const [callee, m] of Object.entries(c.mocks)) {
        const t = mockTarget(callee, imports)
        const lit = (v: unknown) => `${toLiteral(revive(v))} as never`
        out.push(m.throws !== undefined ? `      ${t}.mockImplementation(() => { throw new Error(${JSON.stringify(m.throws)}); });`
            : m.resolves !== undefined ? `      ${t}.mockResolvedValue(${lit(m.resolves)});`
            : `      ${t}.mockReturnValue(${lit(m.returns)});`)
    }

    out.push('')
    if ('throws' in c.expect) {
        const arg = c.expect.throws === true ? '' : JSON.stringify(c.expect.throws)
        out.push(fn.async ? `      await expect(${call}).rejects.toThrow(${arg});` : `      expect(() => ${call}).toThrow(${arg});`)
    } else {
        out.push(`      const result = ${fn.async ? 'await ' : ''}${call};`)
        out.push(`      expect(result).${c.expect.matcher}(${c.expect.args.map(a => toLiteral(revive(a))).join(', ')});`)
    }
    out.push('    });')
    return out.join('\n')
}

export type Runner = 'jest' | 'vitest'

export const mockableCallees = (fn: Step, steps: Step[]): Set<string> => {
    const imports = importMap(steps)
    return new Set(allCalls(fn.children).filter(s => isMockable(s, imports)).map(s => s.callee!))
}

export function buildTestFile(file: string, steps: Step[], docs: JestDoc[], factory?: InputFactory, runner: Runner = 'jest', plan?: Plan): string | undefined {
    const fns = steps.filter(s => s.kind === 'declare' && s.declType === 'fn' && s.exported)
    if (!fns.length) return undefined

    const imports = importMap(steps)
    const mockModules = new Set<string>()
    const importModules = new Set<string>()
    const usedKeys = new Set<string>(['test', 'describe'])
    const blocks: string[] = []
    const registerMock = (callee: string) => {
        const root = callee.split('.')[0]
        if (!imports.has(root)) return
        importModules.add(imports.get(root)!)
        if (callee === root) mockModules.add(imports.get(root)!)
    }

    for (const fn of fns) {
        const tags = tagFunction(fn, docs)
        const tagOf = new Map(tags.map(t => [t.step, t]))
        tags.forEach(t => {
            t.matchers.forEach(k => usedKeys.add(k))
            if (t.tag.startsWith('mock-') && t.step.callee) registerMock(t.step.callee)
        })
        const cases = plan?.get(fn.value) ?? []
        cases.forEach(c => {
            Object.keys(c.mocks).forEach(registerMock)
            if ('matcher' in c.expect) usedKeys.add(c.expect.matcher)
        })
        // agent cases take over where the condition solver had to leave a TODO
        const rendered = expand(fn.children, { conds: [], calls: [] }).map(sc => renderScenario(fn, sc, tagOf, imports, factory))
            .filter(s => !cases.length || !s.includes('// TODO: arrange'))
        const all = [...rendered, ...cases.map(c => renderCase(fn, c, imports, factory))]
        blocks.push([
            `describe(${JSON.stringify(fn.value)}, () => {`,
            '  afterEach(() => {',
            '    jest.clearAllMocks();',
            '    jest.restoreAllMocks();',
            '  });',
            '',
            all.map(s => s.replace(/^  /gm, '')).join('\n\n'),
            '});',
        ].join('\n'))
    }

    if (blocks.some(b => b.includes('toMatchSnapshot'))) usedKeys.add('toMatchSnapshot')
    const base = path.basename(file).replace(/\.[cm]?[jt]sx?$/, '')
    const links = [...usedKeys].map(k => findDoc(docs, k)).filter((d): d is JestDoc => !!d)
        .map(d => `//   ${d.heading} - ${d.url}`)

    const code = [
        `import { describe, test, expect, jest, afterEach } from '@jest/globals';`,
        `import { ${fns.map(f => f.value).join(', ')} } from './${base}';`,
        ...steps.filter(s => s.declType === 'import' && importModules.has(s.value.match(/from\s+['"]([^'"]+)['"]/)?.[1] ?? '')).map(s => s.value),
        '',
        ...[...mockModules].map(m => `jest.mock(${JSON.stringify(m)});`),
        '',
        '// Generated from the code, frontend rules and sampled DB rows - review before committing. Jest APIs used:',
        ...links,
        '',
        blocks.join('\n\n'),
        '',
    ].join('\n')
    return runner === 'vitest'
        ? code.replace(`import { describe, test, expect, jest, afterEach } from '@jest/globals';`, `import { describe, test, expect, vi, afterEach } from 'vitest';`).replace(/\bjest\./g, 'vi.')
        : code
}

export interface BuildOptions extends CollectOptions {
    force?: boolean;
    stdout?: boolean;
    runner?: Runner;
    // optional edge-case source (the agent); receives each file's steps and the shared input factory
    planner?: (file: string, steps: Step[], factory: InputFactory) => Promise<Plan | undefined>;
}

// Source files -> `<name>.gen.jest.ts` (or `.gen.test.ts` for vitest) next to each one
export async function buildTests(files: string[], opts: BuildOptions = {}): Promise<string[]> {
    let docs: JestDoc[] = []
    try { docs = loadJestDocs() } catch (e) { console.warn(String((e as Error).message)) }

    const sources = await collectInputs(opts)
    sources.notes.forEach(n => console.warn(`[inputs] ${n}`))
    console.warn(`[inputs] ${sources.fields.size} fields, ${sources.shapes.size} shapes, ` +
        `${[...sources.tables.values()].reduce((a, r) => a + r.length, 0)} db rows from ${sources.tables.size} table(s)`)
    const factory = new InputFactory(sources)

    const gen = new TestGenerator(files)
    gen.checkFilesToCheck()
    const written: string[] = []

    for (const [file, steps] of gen.transformer()) {
        const plan = await opts.planner?.(file, steps, factory).catch(e => { console.warn(`[agent] ${file}: ${(e as Error).message} - using native tests only`); return undefined })
        const code = buildTestFile(file, steps, docs, factory, opts.runner, plan)
        if (!code) { console.warn(`No exported functions in ${file}`); continue }
        if (opts.stdout) { console.log(`// ===== ${file}\n${code}`); continue }
        const target = file.replace(/\.[cm]?[jt]sx?$/, opts.runner === 'vitest' ? '.gen.test.ts' : '.gen.jest.ts')
        if (fs.existsSync(target) && !opts.force) { console.warn(`${target} exists - use --force to overwrite`); continue }
        fs.writeFileSync(target, code)
        written.push(target)
    }
    return written
}

if (require.main === module) {
    const args = process.argv.slice(2)
    const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
    const valueFlags = new Set(['--frontend', '--backend', '--runner', '--database-url', '--env'])
    const files = args.filter((a, i) => !a.startsWith('--') && !valueFlags.has(args[i - 1])).map(f => path.resolve(f))
    if (!files.length) {
        console.error('Usage: npx tsx bot/testBuilder.ts <source files...> [--frontend dir] [--backend dir] [--runner jest|vitest] [--no-db] [--database-url url] [--env file] [--force] [--stdout]')
        process.exit(1)
    }
    const exists = (d: string) => fs.existsSync(d) ? d : undefined
    buildTests(files, {
        force: args.includes('--force'),
        stdout: args.includes('--stdout'),
        runner: opt('--runner') === 'vitest' ? 'vitest' : 'jest',
        db: !args.includes('--no-db'),
        databaseUrl: opt('--database-url'),
        envFile: opt('--env'),
        frontendDir: path.resolve(opt('--frontend') ?? exists('frontend') ?? '.'),
        backendDir: path.resolve(opt('--backend') ?? exists('backend') ?? '.'),
    }).then(w => w.forEach(f => console.log(`Wrote ${f}`))).catch(e => { console.error(e); process.exit(1) })
}
