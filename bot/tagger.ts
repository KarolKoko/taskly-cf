import { Step } from './transformer';
import { JestDoc } from './jestDocs';

export type TagName =
    | 'returns-value' | 'throws' | 'awaits' | 'branch' | 'loop' | 'error-path'
    | 'mock-api' | 'mock-db' | 'mock-dependency';

// Links one projected code step to the Jest APIs that test it.
export interface Tag {
    tag: TagName;
    step: Step;
    matchers: string[];   // keys into the Jest docs, best first (e.g. "toBe", "jest.mock")
    docs: JestDoc[];
    note: string;
}

export const LITERAL = /^(-?\d+(\.\d+)?|'[^']*'|"[^"]*"|`[^`$]*`|true|false|null|undefined)$/

// Prefer the main API pages over tutorials when a key is documented in several places
const PAGE_ORDER = ['expect', 'jest-object', 'mock-function-api', 'api']

export function findDoc(docs: JestDoc[], key: string): JestDoc | undefined {
    const hits = docs.filter(d => d.key === key)
    return hits.sort((a, b) => rank(a.page) - rank(b.page))[0]
}
const rank = (page: string) => { const i = PAGE_ORDER.indexOf(page); return i === -1 ? 99 : i }

function returnMatcher(value: string): string {
    if (value === '' || value === 'undefined') return 'toBeUndefined'
    if (value === 'null') return 'toBeNull'
    return LITERAL.test(value) ? 'toBe' : 'toEqual'
}

// Walks one `declare fn` step and tags every step a unit test has to cover.
export function tagFunction(fn: Step, docs: JestDoc[]): Tag[] {
    const tags: Tag[] = []
    const add = (tag: TagName, step: Step, matchers: string[], note: string) =>
        tags.push({
            tag, step, matchers, note,
            docs: matchers.map(k => findDoc(docs, k)).filter((d): d is JestDoc => !!d),
        })

    const visit = (steps: Step[]) => {
        for (const s of steps) {
            switch (s.kind) {
                case 'return':
                    add('returns-value', s, [returnMatcher(s.value), fn.async ? 'resolves' : 'expect'], 'assert the returned value')
                    break
                case 'throw':
                    add('throws', s, fn.async ? ['rejects', 'toThrow'] : ['toThrow'], 'assert the thrown error')
                    break
                case 'await':
                    add('awaits', s, ['resolves'], 'async step - test must await')
                    break
                case 'branch':
                    add('branch', s, ['test.each', 'test'], 'one test per branch outcome')
                    break
                case 'loop':
                    add('loop', s, ['test.each'], 'cover empty, single and many iterations')
                    break
                case 'try':
                    add('error-path', s, fn.async ? ['rejects', 'toThrow'] : ['toThrow'], 'cover the catch path by making a dependency fail')
                    break
                case 'call':
                    if (s.coreAction === 'api_call') {
                        add('mock-api', s, ['jest.spyOn', 'mockResolvedValue', 'toHaveBeenCalledWith'], 'stub the network call and assert its arguments')
                    } else if (s.coreAction === 'db_save') {
                        add('mock-db', s, ['jest.mock', 'mockResolvedValue', 'toHaveBeenCalledWith'], 'stub the persistence call and assert what is saved')
                    } else if (s.isExternal) {
                        add('mock-dependency', s, ['jest.mock', 'toHaveBeenCalledWith'], 'dependency from another module')
                    }
                    break
            }
            visit(s.children)
            if (s.else) visit(s.else)
            if (s.catch) visit(s.catch)
            if (s.finally) visit(s.finally)
        }
    }
    visit(fn.children)
    return tags
}
