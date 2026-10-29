import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { buildTests, skipped } from '../testBuilder';
import { agentPlanner, agentSummary } from '../llmTests';
import { changedRanges, changedFunctions } from '../diff';
import { resolveTarget, Target } from '../runners';

const changedSummary: string[] = []

// Runs in CI on pull_request: changed source files -> native tests (+ agent edge cases) -> jest -> pr-report.md
const REPORT = 'pr-report.md'
const TAIL_LINES = 60

function changedFiles(): string[] {
    const base = process.env.BASE_SHA || 'origin/master'
    const out = process.env.CHANGED_FILES?.split(',').join('\n') ??
        execFileSync('git', ['diff', '--name-only', '--diff-filter=AM', `${base}...HEAD`], { encoding: 'utf8' })
    return out.split('\n').map(f => f.trim()).filter(f =>
        /^(frontend|backend)\/.*\.tsx?$/.test(f) && !/\.(test|spec|gen\.jest|gen\.test|d)\.tsx?$/.test(f) &&
        !/(^|\/)(node_modules|tests?|generated)\//.test(f) && fs.existsSync(f))
}

function report(ok: boolean, body: string, mode: string): never {
    const agent = agentSummary.length ? `\n\n**Agent edge cases**\n${agentSummary.map(l => `- ${l}`).join('\n')}` : ''
    fs.writeFileSync(REPORT, `### Generated tests ${ok ? 'passed' : 'failed'} (${mode})\n\n${body}${agent}\n`)
    console.log(body)
    process.exit(ok ? 0 : 1)
}

async function main() {
    const useLlm = process.env.USE_LLM === 'true'
    const mode = useLlm ? `AST builder + agent ${process.env.LLM_MODEL || 'gpt-4o-mini'}` : 'AST builder'
    const files = changedFiles()
    if (!files.length) report(true, 'No changed frontend/backend source files to test.', mode)

    const base = process.env.BASE_SHA || 'origin/master'
    let written: string[]
    try {
        written = await buildTests(files.map(f => path.resolve(f)), {
            force: true,
            db: !!process.env.DATABASE_URL,
            frontendDir: path.resolve('frontend'),
            backendDir: path.resolve('backend'),
            planner: useLlm ? agentPlanner : undefined,
            changed: (file, fns) => {
                const set = process.env.CHANGED_FILES ? new Set(fns.map(f => f.value)) : changedFunctions(fns, changedRanges(path.relative(process.cwd(), file).replace(/\\/g, '/'), base))
                changedSummary.push(`\`${path.relative(process.cwd(), file).replace(/\\/g, '/')}\`: ${[...set].map(n => `\`${n}\``).join(', ') || 'none'}`)
                return set
            },
        })
    } catch (e) {
        report(false, `Test generation failed:\n\`\`\`text\n${(e as Error).message}\n\`\`\``, mode)
    }
    if (!written.length) report(true, 'No exported functions in the changed files - nothing to test.', mode)

    // one run per package, with that package's own runner
    const groups = new Map<string, { target: Target; files: string[] }>()
    for (const f of written) {
        const target = resolveTarget(f, /\.gen\.jest\.ts$/.test(f) ? 'jest' : undefined)
        const g = groups.get(target.pkgDir) ?? { target, files: [] }
        g.files.push(f)
        groups.set(target.pkgDir, g)
    }
    // CI mode refuses to write new snapshots; generated tests create theirs on first run
    const env = { ...process.env, CI: '' }
    let ok = true
    const logs: string[] = []
    for (const { target, files: fs_ } of groups.values()) {
        const rel = fs_.map(f => path.relative(target.pkgDir, f).replace(/\\/g, '/'))
        const args = target.runner === 'vitest' ? ['vitest', 'run', '--update=new', ...rel] : ['jest', '--ci=false', '--runTestsByPath', ...fs_]
        const run = spawnSync('npx', args, { encoding: 'utf8', cwd: target.pkgDir, env, shell: process.platform === 'win32' })
        ok = ok && run.status === 0
        logs.push(`${path.relative(process.cwd(), target.pkgDir) || '.'} (${target.runner}):\n${`${run.stdout ?? ''}\n${run.stderr ?? ''}`.trim().split('\n').slice(-TAIL_LINES).join('\n')}`)
    }
    const list = written.map(f => `- \`${path.relative(process.cwd(), f).replace(/\\/g, '/')}\``).join('\n')
    const skippedList = skipped.length ? `\n\nSkipped:\n${skipped.map(s => `- ${s}`).join('\n')}` : ''
    report(ok, `Changed functions:\n${changedSummary.map(l => `- ${l}`).join('\n')}\n\nFiles:\n${list}${skippedList}\n\n\`\`\`text\n${logs.join('\n\n')}\n\`\`\``, mode)
}

main().catch(e => report(false, `\`\`\`text\n${String(e?.stack ?? e)}\n\`\`\``, 'error'))
