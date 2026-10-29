import { execFileSync } from 'child_process';
import { Step } from './transformer';

export type Ranges = 'all' | [number, number][];

// Changed line ranges (new-file numbering) of one file; 'all' for files added by the PR.
export function changedRanges(file: string, base: string): Ranges {
    const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    if (git('diff', '--name-status', '--diff-filter=A', `${base}...HEAD`, '--', file).trim()) return 'all'
    const ranges: [number, number][] = []
    for (const m of git('diff', '-U0', '--no-color', `${base}...HEAD`, '--', file).matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
        const start = Number(m[1])
        const len = m[2] === undefined ? 1 : Number(m[2])
        ranges.push([start, start + Math.max(len, 1) - 1])   // pure deletions still touch the line they were removed at
    }
    return ranges
}

// Exported functions whose body overlaps a changed range. A change outside every exported function
// (helpers, imports, constants) can affect any of them, so it selects all of them.
export function changedFunctions(fns: Step[], ranges: Ranges): Set<string> {
    if (ranges === 'all') return new Set(fns.map(f => f.value))
    const hit = (f: Step, [a, b]: [number, number]) => a <= (f.endLine ?? f.line) && b >= f.line
    if (ranges.some(r => !fns.some(f => hit(f, r)))) return new Set(fns.map(f => f.value))
    return new Set(fns.filter(f => ranges.some(r => hit(f, r))).map(f => f.value))
}
