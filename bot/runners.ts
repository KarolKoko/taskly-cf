import * as fs from 'fs';
import * as path from 'path';

export type Runner = 'jest' | 'vitest'

export interface Target {
    runner: Runner;
    pkgDir: string;      // where the test command runs
    testsDir?: string;   // set when the package's vitest `include` only matches a tests/ folder
    esm?: boolean;       // "type": "module" - relative imports need the `.js` suffix
}

// The package's own runner wins: vitest when it is a dependency, otherwise the root jest setup.
export function resolveTarget(file: string, forced?: Runner): Target {
    let dir = path.dirname(file)
    while (!fs.existsSync(path.join(dir, 'package.json')) && path.dirname(dir) !== dir) dir = path.dirname(dir)
    const pkg = fs.existsSync(path.join(dir, 'package.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) : {}
    const runner = forced ?? ('vitest' in { ...pkg.dependencies, ...pkg.devDependencies } ? 'vitest' : 'jest')
    const cfg = ['vitest.config.ts', 'vitest.config.mts', 'vitest.config.js', 'vite.config.ts'].map(f => path.join(dir, f)).find(fs.existsSync)
    const include = cfg && fs.readFileSync(cfg, 'utf8').match(/include:\s*\[\s*['"]([^'"*]+)\//)?.[1]
    const inside = !!include && path.resolve(file).startsWith(path.join(dir, include) + path.sep)
    const tsconfig = path.join(dir, 'tsconfig.json')
    const esm = pkg.type === 'module' && fs.existsSync(tsconfig) && /"module(Resolution)?"\s*:\s*"node(16|next)"/i.test(fs.readFileSync(tsconfig, 'utf8'))
    return { runner, pkgDir: dir, esm, testsDir: runner === 'vitest' && include && !inside ? path.join(dir, include) : undefined }
}

export function testFileFor(file: string, t: Target, jsx: boolean): string {
    const base = path.basename(file).replace(/\.[cm]?[jt]sx?$/, '')
    const name = t.runner === 'vitest' ? `${base}.gen.test.${jsx ? 'tsx' : 'ts'}` : `${base}.gen.jest.ts`
    return path.join(t.testsDir ?? path.dirname(file), name)
}

// Import specifier from the test file to a module that was referenced relative to the source file.
export function respec(spec: string, srcDir: string, testDir: string, esm = false): string {
    if (!spec.startsWith('.')) return spec
    const rel = path.relative(testDir, path.resolve(srcDir, spec)).replace(/\\/g, '/')
    const withExt = esm && !/\.[cm]?[jt]sx?$|\.json$/.test(rel) ? `${rel}.js` : rel
    return withExt.startsWith('.') ? withExt : `./${withExt}`
}
