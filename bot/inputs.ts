import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { createRequire } from 'module';
import { pathToFileURL } from 'url';

// Everything the builder knows about "what real input looks like", gathered from:
//  - backend zod schemas (limits, enums, formats)       -> fields / shapes
//  - frontend types, validate* functions, fixtures       -> fields / shapes / enums / examples
//  - rows read (read-only) from the database             -> tables
export interface FieldSpec {
    type?: 'string' | 'number' | 'boolean' | 'array' | 'object';
    nullable?: boolean;
    required?: boolean;
    minLength?: number;
    maxLength?: number;
    minimum?: number;
    maximum?: number;
    enum?: unknown[];
    format?: string;
    pattern?: string;
    default?: unknown;
}

type Row = Record<string, unknown>

export interface InputSources {
    fields: Map<string, FieldSpec>;
    shapes: Map<string, string[]>;        // type name -> field names
    enums: Map<string, unknown[]>;        // string-literal union name -> values
    tables: Map<string, Row[]>;
    examples: Map<string, Row>;           // literal objects found in frontend code (fixtures, form defaults)
    notes: string[];
}

export const emptySources = (): InputSources => ({
    fields: new Map(), shapes: new Map(), enums: new Map(), tables: new Map(), examples: new Map(), notes: [],
})

export interface CollectOptions {
    frontendDir?: string;
    backendDir?: string;
    databaseUrl?: string;
    envFile?: string;
    db?: boolean;
    rowsPerTable?: number;
}

const SKIP_DIR = /node_modules|[\\/]dist[\\/]|[\\/]generated[\\/]|design-system|[\\/]\./
const SKIP_FILE = /\.(test|spec|stories)\.|\.d\.ts$/

function walk(dir: string, out: string[] = []): string[] {
    if (!fs.existsSync(dir)) return out
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) { if (!SKIP_DIR.test(p + path.sep)) walk(p, out) }
        else if (/\.[cm]?[jt]sx?$/.test(e.name) && !SKIP_FILE.test(e.name)) out.push(p)
    }
    return out
}

function merge(map: Map<string, FieldSpec>, name: string, spec: FieldSpec) {
    const cur = map.get(name) ?? {}
    const next: FieldSpec = { ...cur }
    for (const [k, v] of Object.entries(spec)) if (v !== undefined) (next as any)[k] = v
    if (cur.maxLength !== undefined && spec.maxLength !== undefined) next.maxLength = Math.min(cur.maxLength, spec.maxLength)
    if (cur.minLength !== undefined && spec.minLength !== undefined) next.minLength = Math.max(cur.minLength, spec.minLength)
    map.set(name, next)
}

// ---------- backend: zod schemas ----------
function jsonToSpec(p: any): FieldSpec {
    const spec: FieldSpec = {}
    const variants: any[] = p.anyOf ?? [p]
    if (variants.some(v => v.type === 'null')) spec.nullable = true
    const main = variants.find(v => v.type !== 'null') ?? {}
    const t = main.type === 'integer' ? 'number' : main.type
    if (['string', 'number', 'boolean', 'array', 'object'].includes(t)) spec.type = t
    for (const k of ['minLength', 'maxLength', 'minimum', 'maximum', 'format', 'pattern', 'enum'] as const) {
        if (main[k] !== undefined) (spec as any)[k] = main[k]
    }
    if (main.const !== undefined) spec.enum = [main.const]
    if (p.default !== undefined) spec.default = p.default
    return spec
}

async function loadZodSchemas(dir: string, src: InputSources) {
    const files = walk(path.join(dir, 'src')).filter(f => /from\s+['"]zod['"]/.test(fs.readFileSync(f, 'utf8')))
    const schemaFields = new Map<string, string[]>()
    for (const file of files) {
        let mod: Record<string, any>
        try { mod = await import(pathToFileURL(file).href) }
        catch (e) { src.notes.push(`zod: cannot import ${file}: ${(e as Error).message.split('\n')[0]}`); continue }
        let zod: any
        try { zod = createRequire(file)('zod') } catch { continue }
        for (const [name, value] of Object.entries(mod)) {
            if (!value || typeof value !== 'object' || !('_zod' in value)) continue
            let js: any
            try { js = zod.toJSONSchema(value, { io: 'input', unrepresentable: 'any' }) } catch { continue }
            if (!js?.properties) continue
            const required = new Set<string>(js.required ?? [])
            for (const [k, p] of Object.entries<any>(js.properties)) {
                merge(src.fields, k, { ...jsonToSpec(p), required: required.has(k) })
            }
            schemaFields.set(name, Object.keys(js.properties))
        }
    }
    for (const file of walk(path.join(dir, 'src'))) {
        for (const m of fs.readFileSync(file, 'utf8').matchAll(/type\s+(\w+)\s*=\s*z\.infer<typeof\s+(\w+)>/g)) {
            const f = schemaFields.get(m[2])
            if (f) src.shapes.set(m[1], f)
        }
    }
}

// ---------- frontend: types, validators, fixtures ----------
function literalValue(n: ts.Expression): unknown {
    if (ts.isStringLiteralLike(n)) return n.text
    if (ts.isNumericLiteral(n)) return Number(n.text)
    if (n.kind === ts.SyntaxKind.TrueKeyword) return true
    if (n.kind === ts.SyntaxKind.FalseKeyword) return false
    if (n.kind === ts.SyntaxKind.NullKeyword) return null
    if (ts.isPrefixUnaryExpression(n) && n.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(n.operand)) return -Number(n.operand.text)
    if (ts.isObjectLiteralExpression(n)) {
        const o: Row = {}
        for (const p of n.properties) {
            if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) {
                const v = literalValue(p.initializer)
                if (v !== undefined) o[p.name.text] = v
            }
        }
        return o
    }
    if (ts.isAsExpression(n)) return literalValue(n.expression)
    return undefined
}

function typeSpec(t: ts.TypeNode | undefined): FieldSpec {
    if (!t) return {}
    if (t.kind === ts.SyntaxKind.StringKeyword) return { type: 'string' }
    if (t.kind === ts.SyntaxKind.NumberKeyword) return { type: 'number' }
    if (t.kind === ts.SyntaxKind.BooleanKeyword) return { type: 'boolean' }
    if (ts.isArrayTypeNode(t)) return { type: 'array' }
    if (ts.isUnionTypeNode(t)) {
        const spec: FieldSpec = {}
        const lits: unknown[] = []
        for (const m of t.types) {
            if (ts.isLiteralTypeNode(m) && m.literal.kind === ts.SyntaxKind.NullKeyword) spec.nullable = true
            else if (ts.isLiteralTypeNode(m) && ts.isStringLiteral(m.literal)) lits.push(m.literal.text)
            else Object.assign(spec, typeSpec(m))
        }
        if (lits.length) { spec.enum = lits; spec.type = 'string' }
        return spec
    }
    return {}
}

// `if (<bad value>) errors.<field> = '...'` -> constraints on <field>
function validatorRules(fn: ts.Node, src: InputSources) {
    const lastName = (e: ts.Expression): string | undefined => {
        while (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression)) e = e.expression.expression
        return ts.isPropertyAccessExpression(e) ? e.name.text : ts.isIdentifier(e) ? e.text : undefined
    }
    const visit = (n: ts.Node) => {
        if (ts.isIfStatement(n)) {
            const fields = new Set<string>()
            const find = (c: ts.Node) => {
                if (ts.isBinaryExpression(c) && c.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                    (ts.isPropertyAccessExpression(c.left) || ts.isElementAccessExpression(c.left))) {
                    const l = c.left
                    fields.add(ts.isPropertyAccessExpression(l) ? l.name.text : ts.isStringLiteralLike(l.argumentExpression) ? l.argumentExpression.text : '')
                }
                ts.forEachChild(c, find)
            }
            find(n.thenStatement)
            fields.delete('')
            const rule = (c: ts.Node) => {
                for (const field of fields) {
                    if (ts.isPrefixUnaryExpression(c) && c.operator === ts.SyntaxKind.ExclamationToken && lastName(c.operand as ts.Expression) === field) {
                        merge(src.fields, field, { required: true, minLength: 1 })
                    }
                    if (ts.isBinaryExpression(c) && ts.isNumericLiteral(c.right) && ts.isPropertyAccessExpression(c.left) &&
                        c.left.name.text === 'length' && lastName(c.left.expression) === field) {
                        const v = Number(c.right.text)
                        const op = c.operatorToken.kind
                        if (op === ts.SyntaxKind.GreaterThanToken) merge(src.fields, field, { maxLength: v })
                        else if (op === ts.SyntaxKind.GreaterThanEqualsToken) merge(src.fields, field, { maxLength: v - 1 })
                        else if (op === ts.SyntaxKind.LessThanToken) merge(src.fields, field, { minLength: v })
                        else if (op === ts.SyntaxKind.LessThanEqualsToken) merge(src.fields, field, { minLength: v + 1 })
                    }
                    if (ts.isCallExpression(c) && ts.isPropertyAccessExpression(c.expression) && c.expression.name.text === 'test' &&
                        ts.isRegularExpressionLiteral(c.expression.expression) && c.arguments[0] && lastName(c.arguments[0]) === field) {
                        const re = c.expression.expression.text
                        const pattern = re.slice(1, re.lastIndexOf('/'))
                        merge(src.fields, field, { pattern, ...(/\\d\{4\}-\\d\{2\}-\\d\{2\}/.test(pattern) ? { format: 'date' } : {}) })
                    }
                }
                ts.forEachChild(c, rule)
            }
            if (fields.size) rule(n.expression)
        }
        ts.forEachChild(n, visit)
    }
    visit(fn)
}

function scanFrontend(dir: string, src: InputSources) {
    for (const file of walk(path.join(dir, 'src'))) {
        const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
        const visit = (n: ts.Node) => {
            if (ts.isInterfaceDeclaration(n) || (ts.isTypeAliasDeclaration(n) && ts.isTypeLiteralNode(n.type))) {
                const members = ts.isInterfaceDeclaration(n) ? n.members : (n.type as ts.TypeLiteralNode).members
                const names: string[] = []
                for (const m of members) {
                    if (ts.isPropertySignature(m) && (ts.isIdentifier(m.name) || ts.isStringLiteral(m.name))) {
                        names.push(m.name.text)
                        merge(src.fields, m.name.text, { ...typeSpec(m.type), ...(m.questionToken ? { required: false } : {}) })
                    }
                }
                src.shapes.set(n.name.text, names)
            } else if (ts.isTypeAliasDeclaration(n) && ts.isUnionTypeNode(n.type)) {
                const spec = typeSpec(n.type)
                if (spec.enum) src.enums.set(n.name.text, spec.enum)
            } else if (ts.isFunctionDeclaration(n) && n.name && /^validate/i.test(n.name.text)) {
                validatorRules(n, src)
            } else if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
                if ((ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer)) && /^validate/i.test(n.name.text)) {
                    validatorRules(n.initializer, src)
                } else if (ts.isObjectLiteralExpression(n.initializer)) {
                    const v = literalValue(n.initializer) as Row
                    if (Object.keys(v).length) src.examples.set(n.name.text, v)
                }
            }
            ts.forEachChild(n, visit)
        }
        visit(sf)
    }
}

// ---------- database (read-only) ----------
function readEnv(file: string): Record<string, string> {
    const out: Record<string, string> = {}
    if (!fs.existsSync(file)) return out
    for (const l of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
        if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2')
    }
    return out
}

function connectionString(opts: CollectOptions): string | undefined {
    const env = { ...readEnv(opts.envFile ?? path.resolve('.env')), ...process.env } as Record<string, string | undefined>
    if (opts.databaseUrl ?? env.TESTGEN_DATABASE_URL ?? env.DATABASE_URL) return opts.databaseUrl ?? env.TESTGEN_DATABASE_URL ?? env.DATABASE_URL
    const { POSTGRES_USER: u, POSTGRES_PASSWORD: p, POSTGRES_DB: d, DB_PORT: port } = env
    if (!u || !d) return undefined
    // POSTGRES_HOST is the docker-compose service name, so use the published port on localhost
    return `postgres://${encodeURIComponent(u)}:${encodeURIComponent(p ?? '')}@127.0.0.1:${port ?? 5432}/${d}`
}

async function loadDb(opts: CollectOptions, src: InputSources) {
    const url = connectionString(opts)
    if (!url) { src.notes.push('db: no connection settings found'); return }
    let pg: any
    try { pg = await import('pg') } catch { src.notes.push('db: "pg" is not installed'); return }
    const lib = pg.default ?? pg
    const client = new lib.Client({
        connectionString: url,
        connectionTimeoutMillis: 3000,
        types: { getTypeParser: (oid: number, fmt?: string) => oid === 1082
            ? (v: string) => new Date(`${v}T00:00:00.000Z`)
            : lib.types.getTypeParser(oid, fmt) },
    })
    try {
        await client.connect()
        await client.query('BEGIN READ ONLY')
        const cols = await client.query(
            `SELECT table_name, column_name, data_type, is_nullable, character_maximum_length
             FROM information_schema.columns WHERE table_schema = 'public' AND table_name NOT LIKE '\\_%' ORDER BY table_name, ordinal_position`)
        const tables = [...new Set<string>(cols.rows.map((r: any) => r.table_name))].filter(t => !/^_prisma/.test(t))
        for (const c of cols.rows) {
            const dt: string = c.data_type
            merge(src.fields, c.column_name, {
                type: /int|numeric|double|real|serial/.test(dt) ? 'number' : dt === 'boolean' ? 'boolean' : /char|text|date|time|uuid/.test(dt) ? 'string' : undefined,
                nullable: c.is_nullable === 'YES' || undefined,
                maxLength: c.character_maximum_length ?? undefined,
                format: dt === 'date' ? 'date' : /^timestamp/.test(dt) ? 'date-time' : undefined,
            })
        }
        for (const t of tables) {
            const r = await client.query(`SELECT * FROM "${t.replace(/"/g, '""')}" ORDER BY 1 LIMIT ${Math.max(1, opts.rowsPerTable ?? 3)}`)
            if (r.rows.length) src.tables.set(t, r.rows)
        }
        await client.query('ROLLBACK')
    } catch (e) {
        src.notes.push(`db: ${(e as Error).message.split('\n')[0]}`)
    } finally {
        await client.end().catch(() => undefined)
    }
}

export async function collectInputs(opts: CollectOptions = {}): Promise<InputSources> {
    const src = emptySources()
    if (opts.db !== false) await loadDb(opts, src)
    if (opts.backendDir) await loadZodSchemas(opts.backendDir, src)
    if (opts.frontendDir) scanFrontend(opts.frontendDir, src)
    return src
}

// ---------- value generation ----------
const DATE_ONLY = /\\d\{4\}-\\d\{2\}-\\d\{2\}/

export function sample(name: string, spec: FieldSpec = {}): unknown {
    if (spec.enum?.length) return spec.enum[0]
    const type = spec.type ?? (name === 'id' ? 'number' : 'string')
    if (type === 'boolean') return true
    if (type === 'number') return Math.max(spec.minimum ?? 1, 1)
    if (type === 'array') return []
    if (type === 'object') return {}
    if (spec.format === 'date' || (spec.pattern && DATE_ONLY.test(spec.pattern)) || /(^|_)date$/i.test(name)) return '2026-01-15'
    if (spec.format === 'date-time' || /_at$|At$/.test(name)) return '2026-01-15T12:00:00Z'
    const label = name.replace(/_/g, ' ')
    let s = `Sample ${label}`.slice(0, spec.maxLength ?? 1e9)
    while (s.length < (spec.minLength ?? 0)) s += 'x'
    return s
}

const iso = (d: Date) => d.toISOString()
const toApi = (v: unknown, spec: FieldSpec | undefined, name: string) => {
    if (!(v instanceof Date)) return v
    return spec?.format === 'date' || /(^|_)date$/i.test(name) ? iso(v).slice(0, 10) : iso(v)
}

export interface Built { value: unknown; make?: () => unknown }

export class InputFactory {
    constructor(readonly src: InputSources) {}

    private bestRow(fields: string[]): Row | undefined {
        let best: { row: Row; score: number } | undefined
        for (const rows of this.src.tables.values()) {
            if (!rows[0]) continue
            const score = fields.filter(f => f in rows[0]).length / Math.max(fields.length, 1)
            if (score >= 0.5 && (!best || score > best.score)) best = { row: rows[0], score }
        }
        return best?.row
    }

    private rowByTypeName(typeName: string): Row | undefined {
        const lower = typeName.toLowerCase()
        for (const [t, rows] of this.src.tables) {
            if (rows[0] && lower.includes(t.replace(/s$/, '').toLowerCase())) return rows[0]
        }
        return undefined
    }

    private exampleValue(field: string): unknown {
        for (const ex of this.src.examples.values()) {
            const v = ex[field]
            if (v !== undefined && v !== '' && v !== null) return v
        }
        return undefined
    }

    private shape(fields: string[]): Row {
        const row = this.bestRow(fields)
        const out: Row = {}
        for (const f of fields) {
            const spec = this.src.fields.get(f)
            const fromRow = row && f in row ? toApi(row[f], spec, f) : undefined
            out[f] = fromRow !== undefined && fromRow !== null ? fromRow : this.exampleValue(f) ?? sample(f, spec)
        }
        return out
    }

    private single(t: string, name: string): unknown {
        if (t === 'string') return sample(name, this.src.fields.get(name) ?? { type: 'string' })
        if (t === 'boolean') return false
        if (t === 'Date') return new Date('2026-01-15T00:00:00.000Z')
        if (t === 'number') {
            if (/^id$|Id$/.test(name)) {
                for (const rows of this.src.tables.values()) if (typeof rows[0]?.id === 'number') return rows[0].id
                return 1
            }
            return sample(name, { ...this.src.fields.get(name), type: 'number' })
        }
        const en = this.src.enums.get(t)
        if (en?.length) return en[0]
        const shape = this.src.shapes.get(t)
        if (shape) return this.shape(shape)
        const row = this.rowByTypeName(t)
        if (row) return { ...row }
        // No DB sample: fall back to the closest known shape ("TodoRecord" -> "Todo"); persistence types hold Dates
        const key = [...this.src.shapes.keys()].filter(k => t.toLowerCase().startsWith(k.toLowerCase())).sort((a, b) => b.length - a.length)[0]
        if (key) {
            const built = this.shape(this.src.shapes.get(key)!)
            if (/(Record|Model|Row|Entity)$/.test(t)) {
                for (const [k, v] of Object.entries(built)) {
                    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/.test(v)) built[k] = new Date(v.length === 10 ? `${v}T00:00:00.000Z` : v)
                }
            }
            return built
        }
        return undefined
    }

    forType(typeText: string, name: string): Built {
        const t = typeText.replace(/\s+/g, '').replace(/\|(null|undefined)|(null|undefined)\|/g, '')
        const arr = t.match(/^(.*)\[\]$/)?.[1] ?? t.match(/^(?:Readonly)?Array<(.*)>$/)?.[1]
        const base = arr ?? t
        const make = () => this.single(base, name)
        return arr !== undefined ? { value: [make()].filter(v => v !== undefined), make } : { value: make(), make }
    }
}

// ---------- condition solver ----------
export interface Param { name: string; value: unknown; make?: () => unknown }

const FLIP: Record<string, string> = { '>': '<=', '>=': '<', '<': '>=', '<=': '>', '===': '!==', '!==': '===', '==': '!=', '!=': '==' }
const MIRROR: Record<string, string> = { '>': '<', '>=': '<=', '<': '>', '<=': '>=' }
const NO_LITERAL = Symbol('no-literal')
const WRAPPERS = new Set(['trim', 'toLowerCase', 'toUpperCase', 'trimStart', 'trimEnd'])

// Turns scenario conditions (`!payload.title`, `todos.length > 0`, `age >= 18`...) into concrete param values.
// Returns the conditions it could not solve.
export function applyConditions(conds: string[], params: Param[], src: InputSources): string[] {
    const byName = new Map(params.map(p => [p.name, p]))
    const unsolved: string[] = []

    const unwrap = (e: ts.Expression): ts.Expression => {
        for (;;) {
            if (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isAsExpression(e)) e = e.expression
            else if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && WRAPPERS.has(e.expression.name.text) && !e.arguments.length) e = e.expression.expression
            else return e
        }
    }
    const parsePath = (e: ts.Expression) => {
        let cur = unwrap(e)
        let len = false
        if (ts.isPropertyAccessExpression(cur) && cur.name.text === 'length') { len = true; cur = unwrap(cur.expression) }
        const segs: string[] = []
        while (ts.isPropertyAccessExpression(cur) || ts.isElementAccessExpression(cur)) {
            if (ts.isPropertyAccessExpression(cur)) segs.unshift(cur.name.text)
            else if (ts.isStringLiteralLike(cur.argumentExpression)) segs.unshift(cur.argumentExpression.text)
            else return undefined
            cur = unwrap(cur.expression)
        }
        const param = ts.isIdentifier(cur) ? byName.get(cur.text) : undefined
        return param ? { param, segs, len } : undefined
    }
    type PP = NonNullable<ReturnType<typeof parsePath>>

    const getAt = (pp: PP): any => pp.segs.reduce<any>((o, k) => (o == null ? undefined : o[k]), pp.param.value)
    const setAt = (pp: PP, v: unknown): boolean => {
        if (!pp.segs.length) { pp.param.value = v; return true }
        if (pp.param.value == null || typeof pp.param.value !== 'object') return false
        let o: any = pp.param.value
        for (const k of pp.segs.slice(0, -1)) { o[k] ??= {}; o = o[k] }
        o[pp.segs[pp.segs.length - 1]] = v
        return true
    }
    const fieldName = (pp: PP) => pp.segs[pp.segs.length - 1] ?? pp.param.name
    const specOf = (pp: PP) => src.fields.get(fieldName(pp))
    const literal = (e: ts.Expression): unknown => {
        e = unwrap(e)
        if (ts.isStringLiteralLike(e)) return e.text
        if (ts.isNumericLiteral(e)) return Number(e.text)
        if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(e.operand)) return -Number(e.operand.text)
        if (e.kind === ts.SyntaxKind.TrueKeyword) return true
        if (e.kind === ts.SyntaxKind.FalseKeyword) return false
        if (e.kind === ts.SyntaxKind.NullKeyword) return null
        if (ts.isIdentifier(e) && e.text === 'undefined') return undefined
        return NO_LITERAL
    }

    const truthy = (pp: PP, want: boolean): boolean => {
        const cur = getAt(pp)
        if (pp.len) return lengthOp(pp, want ? '>' : '===', 0)
        const isTrue = Array.isArray(cur) ? true : typeof cur === 'string' ? cur.trim() !== '' : !!cur
        if (isTrue === want) return true
        if (want) {
            if (typeof cur === 'boolean') return setAt(pp, true)
            const v = pp.segs.length ? sample(fieldName(pp), specOf(pp)) : (pp.param.make?.() ?? 'x')
            return setAt(pp, v)
        }
        const spec = specOf(pp)
        return setAt(pp, spec?.nullable ? null : typeof cur === 'string' ? '' : typeof cur === 'number' ? 0 : typeof cur === 'boolean' ? false : null)
    }

    const lengthOp = (pp: PP, op: string, n: number): boolean => {
        const target = op === '>' ? n + 1 : op === '>=' || op === '<=' || op === '===' || op === '==' ? n
            : op === '<' ? Math.max(n - 1, 0) : op === '!==' || op === '!=' ? n + 1 : NaN
        if (Number.isNaN(target)) return false
        const cur = getAt(pp)
        if (Array.isArray(cur) || (cur == null && pp.param.make && !pp.segs.length && pp.param.value === undefined)) {
            const arr = Array.isArray(cur) ? cur.slice(0, target) : []
            while (arr.length < target) arr.push(pp.segs.length ? 'x' : pp.param.make?.() ?? 'x')
            return setAt(pp, arr)
        }
        return setAt(pp, 'a'.repeat(target))
    }

    const compare = (pp: PP, op: string, lit: unknown): boolean => {
        if (pp.len) return typeof lit === 'number' && lengthOp(pp, op, lit)
        const eq = op === '===' || op === '=='
        const ne = op === '!==' || op === '!='
        if (eq) return setAt(pp, lit)
        if (ne) {
            if (typeof lit === 'number') return setAt(pp, lit + 1)
            if (typeof lit === 'string') return setAt(pp, `${lit}-other`)
            const enumOthers = specOf(pp)?.enum?.filter(v => v !== lit)
            return setAt(pp, enumOthers?.length ? enumOthers[0] : sample(fieldName(pp), specOf(pp)))
        }
        if (typeof lit !== 'number') return false
        return setAt(pp, op === '>' ? lit + 1 : op === '<' ? lit - 1 : lit)
    }

    const regex = (pp: PP, re: RegExp, want: boolean): boolean => {
        const cur = getAt(pp)
        if (typeof cur === 'string' && re.test(cur) === want) return true
        if (want) {
            const v = sample(fieldName(pp), specOf(pp))
            if (typeof v === 'string' && re.test(v)) return setAt(pp, v)
            const guess = ['2026-01-15', '2026-01-15T12:00:00Z', '12:00', '1', '123456', 'abc', 'a@b.co', 'https://example.com', 'A1'].find(c => re.test(c))
            return guess !== undefined && setAt(pp, guess)
        }
        return setAt(pp, '!')
    }

    const apply = (e: ts.Expression, want: boolean): boolean => {
        e = unwrap(e)
        if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken) return apply(e.operand, !want)
        if (ts.isBinaryExpression(e)) {
            const k = e.operatorToken.kind
            if (k === ts.SyntaxKind.AmpersandAmpersandToken) return want ? apply(e.left, true) && apply(e.right, true) : apply(e.left, false)
            if (k === ts.SyntaxKind.BarBarToken) {
                if (want) return apply(e.left, true)
                // terms on derived locals (e.g. `date.getTime()`) can't be solved directly; they follow from the solved ones
                const a = apply(e.left, false), b = apply(e.right, false)
                return a || b
            }
            const op = e.operatorToken.getText()
            if (op in FLIP) {
                const l = literal(e.left), r = literal(e.right)
                const finalOp = want ? op : FLIP[op]
                if (r !== NO_LITERAL) { const pp = parsePath(e.left); return !!pp && compare(pp, finalOp, r) }
                if (l !== NO_LITERAL) { const pp = parsePath(e.right); return !!pp && compare(pp, MIRROR[finalOp] ?? finalOp, l) }
            }
            return false
        }
        if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && e.expression.name.text === 'test' &&
            ts.isRegularExpressionLiteral(e.expression.expression) && e.arguments[0]) {
            const txt = e.expression.expression.text
            const pp = parsePath(e.arguments[0])
            try { return !!pp && regex(pp, new RegExp(txt.slice(1, txt.lastIndexOf('/')), txt.slice(txt.lastIndexOf('/') + 1)), want) } catch { return false }
        }
        const pp = parsePath(e)
        return !!pp && truthy(pp, want)
    }

    for (const raw of conds) {
        const sw = raw.match(/^(.*) matches case (.*)$/)
        const text = sw ? `${sw[1]} === ${sw[2]}` : raw
        const sf = ts.createSourceFile('cond.ts', `(${text});`, ts.ScriptTarget.Latest, true)
        const stmt = sf.statements[0]
        const ok = stmt && ts.isExpressionStatement(stmt) ? apply(stmt.expression, true) : false
        if (!ok) unsolved.push(raw)
    }
    return unsolved
}

// ---------- serialisation ----------
export function toLiteral(v: unknown, indent = 6): string {
    const pad = ' '.repeat(indent)
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? 'new Date(NaN)' : `new Date(${JSON.stringify(v.toISOString())})`
    if (Array.isArray(v)) return v.length ? `[${v.map(x => toLiteral(x, indent)).join(', ')}]` : '[]'
    if (v && typeof v === 'object') {
        const entries = Object.entries(v as Row).filter(([, x]) => x !== undefined)
        if (!entries.length) return '{}'
        return `{\n${entries.map(([k, x]) => `${pad}  ${/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}: ${toLiteral(x, indent + 2)},`).join('\n')}\n${pad}}`
    }
    if (typeof v === 'string' && v.length > 40 && /^(.)\1+$/s.test(v)) return `${JSON.stringify(v[0])}.repeat(${v.length})`
    return v === undefined ? 'undefined' : JSON.stringify(v)
}
