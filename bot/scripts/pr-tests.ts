import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { buildTests } from '../testBuilder';
import { agentPlanner, agentSummary } from '../llmTests';

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

    let written: string[]
    try {
        written = await buildTests(files.map(f => path.resolve(f)), {
            force: true,
            db: !!process.env.DATABASE_URL,
            frontendDir: path.resolve('frontend'),
            backendDir: path.resolve('backend'),
            planner: useLlm ? agentPlanner : undefined,
        })
    } catch (e) {
        report(false, `Test generation failed:\n\`\`\`text\n${(e as Error).message}\n\`\`\``, mode)
    }
    if (!written.length) report(true, 'No exported functions in the changed files - nothing to test.', mode)

    const run = spawnSync('npx', ['jest', '--runTestsByPath', ...written], { encoding: 'utf8', shell: process.platform === 'win32' })
    const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`.trim().split('\n').slice(-TAIL_LINES).join('\n')
    const list = written.map(f => `- \`${path.relative(process.cwd(), f).replace(/\\/g, '/')}\``).join('\n')
    report(run.status === 0, `Files:\n${list}\n\n\`\`\`text\n${output}\n\`\`\``, mode)
}

main().catch(e => report(false, `\`\`\`text\n${String(e?.stack ?? e)}\n\`\`\``, 'error'))
