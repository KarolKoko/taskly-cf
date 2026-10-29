import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { Step } from './transformer';
import { InputFactory, toLiteral } from './inputs';
import { expand, mockableCallees } from './testBuilder';
import { MAX_CASES, MATCHERS, Plan, parsePlan } from './cases';

// The agent reads code and returns edge cases as JSON only; the builder validates and renders them.
// Cost controls: small model, temperature 0, capped output, compact AST digest, on-disk cache keyed by the exact prompt.
const MODEL = process.env.LLM_MODEL || 'gpt-4o-mini'
const BASE_URL = (process.env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '')
const MAX_OUTPUT_TOKENS = Number(process.env.LLM_MAX_OUTPUT_TOKENS) || 900
const CACHE_DIR = path.resolve(process.env.LLM_CACHE_DIR || '.testgen-cache')
const TIMEOUT_MS = 60_000

// Human-readable lines (case + reason) for the PR comment
export const agentSummary: string[] = []

const SKILL_FILE = path.resolve(__dirname, '../.github/skills/propose-edge-cases/SKILL.md')

// The system prompt is the body of the propose-edge-cases skill, so the skill file is what runs.
const SYSTEM = fs.readFileSync(SKILL_FILE, 'utf8')
    .replace(/^---[\s\S]*?---\s*/, '')
    .replace('{{MAX_CASES}}', String(MAX_CASES))
    .replace('{{MATCHERS}}', MATCHERS.join(', '))

function exportedSources(file: string): Map<string, string> {
    const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
    const out = new Map<string, string>()
    const exported = (n: ts.Node) => ts.canHaveModifiers(n) && !!ts.getModifiers(n)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)
    for (const st of sf.statements) {
        if (ts.isFunctionDeclaration(st) && st.name && exported(st)) out.set(st.name.text, st.getText())
        else if (ts.isVariableStatement(st) && exported(st)) {
            for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) out.set(d.name.text, st.getText())
        }
    }
    return out
}

function digest(fns: Step[], steps: Step[], sources: Map<string, string>, factory: InputFactory): string {
    return fns.map(fn => {
        const inputs = (fn.params ?? []).map((p, i) => `${p}=${toLiteral(factory.forType(fn.paramTypes?.[i] ?? '', p).value, 0).replace(/\s*\n\s*/g, ' ')}`)
        const paths = expand(fn.children, { conds: [], calls: [] })
            .map(sc => `- ${sc.conds.join(' && ') || 'always'} => ${sc.outcome ? `${sc.outcome.kind} ${sc.outcome.value}` : 'no return'}`)
        return [`Function ${fn.value}:`, sources.get(fn.value), `Sample inputs: ${inputs.join('; ') || 'none'}`,
            `Mockable: ${[...mockableCallees(fn, steps)].join(', ') || 'none'}`, `Paths:\n${paths.join('\n')}`].join('\n')
    }).join('\n\n')
}

async function ask(prompt: string): Promise<string> {
    const key = process.env.LLM_API_KEY
    if (!key) throw new Error('USE_LLM=true but LLM_API_KEY is not set')
    const cacheFile = path.join(CACHE_DIR, `${crypto.createHash('sha256').update(MODEL + SYSTEM + prompt).digest('hex')}.json`)
    if (fs.existsSync(cacheFile)) return fs.readFileSync(cacheFile, 'utf8')

    const res = await fetch(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({
            model: MODEL, temperature: 0, max_tokens: MAX_OUTPUT_TOKENS, response_format: { type: 'json_object' },
            messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }],
        }),
    })
    if (!res.ok) throw new Error(`LLM request failed: ${res.status} ${(await res.text()).slice(0, 200)}`)
    const json = await res.json() as { choices: { message: { content: string } }[]; usage?: { total_tokens: number } }
    const content = json.choices[0].message.content
    JSON.parse(content) // do not cache anything that is not JSON
    console.warn(`[agent] ${MODEL}: ${json.usage?.total_tokens ?? '?'} tokens`)
    fs.mkdirSync(CACHE_DIR, { recursive: true })
    fs.writeFileSync(cacheFile, content)
    return content
}

export async function agentPlanner(file: string, steps: Step[], factory: InputFactory): Promise<Plan | undefined> {
    const sources = exportedSources(file)
    const fns = steps.filter(s => s.kind === 'declare' && s.declType === 'fn' && s.exported && sources.has(s.value))
    if (!fns.length) return undefined

    const notes: string[] = []
    const plan = parsePlan(JSON.parse(await ask(digest(fns, steps, sources, factory))), fns, fn => mockableCallees(fn, steps), notes)
    notes.forEach(n => console.warn(`[agent] ${n}`))
    for (const [fn, cases] of plan) cases.forEach(c => agentSummary.push(`\`${fn}\`: ${c.name}${c.why ? ` - ${c.why}` : ''}`))
    return plan
}
