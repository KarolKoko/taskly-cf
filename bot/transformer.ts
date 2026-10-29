import * as fs from 'fs';
import * as ts from 'typescript'

type StepKind = 'declare' | 'assign' | 'call' | 'await' | 'result' | 'return' | 'branch' | 'loop' | 'try' | 'throw';

// One step of the "compiled" program, in execution order.
// - declare: declType says what (var | fn | class | import | export); value = name or whole line for import/export
// - assign:  target = assigned variable, value = right side with known variables substituted
// - call:    callee + args (args resolved); children = body of callback arguments
// - await:   value = awaited expression
// - result:  value produced by a call and bound to `target` (declType 'var' if it declares it)
// - return / throw: value = resolved expression
// - branch:  if/switch/case/ternary. value = condition, children = then, else = otherwise
// - loop:    value = header, children = body
// - try:     children = try block, catch / finally = other blocks
export interface Step {
    file: string;
    kind: StepKind;
    line: number;
    endLine?: number;
    value: string;
    declType?: 'var' | 'fn' | 'class' | 'import' | 'export';
    exported?: boolean;
    params?: string[];
    paramTypes?: string[];
    async?: boolean;
    target?: string;
    callee?: string;
    args?: string[];
    isExternal?: boolean;
    coreAction?: 'return' | 'db_save' | 'api_call';
    children: Step[];
    else?: Step[];
    catch?: Step[];
    finally?: Step[];
}

const API_FNS = /^(fetch|\$fetch|axios|got|ky|request|superagent)$/
const API_RECEIVERS = /^(axios|http|https|got|ky|request|superagent|api|client|httpClient)\b/i
const HTTP_METHODS = /^(get|post|put|patch|delete|request|send)$/
const DB_METHODS = /^(save|create|insert|insertOne|insertMany|update|updateOne|updateMany|upsert|bulkCreate|createMany|put|set|add|persist|execute|query|run)$/
const DB_RECEIVERS = /prisma|db|repo|model|collection|knex|sequelize|mongo|supabase|entityManager|orm|pool|connection|\btx\b/i
const SQL_WRITE = /\b(insert|update|delete|replace|upsert)\b/i

const isAnyFn = (n: ts.Node): n is ts.FunctionLikeDeclaration =>
    ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isConstructorDeclaration(n) ||
    ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isGetAccessor(n) || ts.isSetAccessor(n)

const isFnExpr = (n?: ts.Node): n is ts.ArrowFunction | ts.FunctionExpression =>
    !!n && (ts.isArrowFunction(n) || ts.isFunctionExpression(n))

const unwrap = (n: ts.Expression): ts.Expression => {
    while (ts.isAwaitExpression(n) || ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isNonNullExpression(n)) {
        n = n.expression
    }
    return n
}

const bindingNames = (name: ts.BindingName): string[] => {
    if (ts.isIdentifier(name)) return [name.text]
    return name.elements.flatMap(e => ts.isOmittedExpression(e) ? [] : bindingNames(e.name))
}

const ASSIGN_OPS = new Set<ts.SyntaxKind>([
    ts.SyntaxKind.EqualsToken, ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.MinusEqualsToken,
    ts.SyntaxKind.AsteriskEqualsToken, ts.SyntaxKind.SlashEqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken,
    ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.AmpersandAmpersandEqualsToken,
])

const fnMeta = (fn: ts.FunctionLikeDeclaration): Pick<Step, 'params' | 'paramTypes' | 'async'> => ({
    params: fn.parameters.map(p => p.name.getText()),
    paramTypes: fn.parameters.map(p => p.type?.getText().replace(/\s+/g, ' ') ?? ''),
    async: !!ts.getModifiers(fn as ts.HasModifiers)?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword) || undefined,
})

export class TestGenerator {
    private filesToCheck: string[];
    private result?: Map<string, Step[]>;

    constructor(files: string[]) {
        this.filesToCheck = files
    }

    checkFilesToCheck() {
        try {
            const availableFiles = this.filesToCheck.filter((f) => fs.existsSync(f))
            if (availableFiles.length == 0) {
                throw new Error ("Nothing to check - no filesToCheck or invalid path")
            }
            if (availableFiles.length !== this.filesToCheck.length) {
                console.warn(`Some of files to check doesn't exist. Checks only for: ${availableFiles.join(', ')}`)
            }
            this.filesToCheck = availableFiles
        } catch (error) {
            console.error(error)
            process.exit(1)
        }
    }

    // Walks every file like an interpreter: statements in order, expressions evaluated inside-out
    // (arguments/inner calls first), tracking variable values so later steps show real data.
    transformer(): Map<string, Step[]> {
        const program = ts.createProgram(this.filesToCheck, { allowJs: true })
        const checker = program.getTypeChecker()
        const result = new Map<string, Step[]>()

        // name -> resolved value. A name mapped to itself is "opaque" (param, call result, unknown).
        let scope = new Map<string, string>()
        const opaque = (name: string) => scope.set(name, name)

        // child scope; variables the block changed become opaque in the parent (branch/loop outcome unknown)
        const block = <T>(fn: () => T): T => {
            const parent = scope
            scope = new Map(parent)
            try {
                return fn()
            } finally {
                const child = scope
                scope = parent
                parent.forEach((v, k) => { if (child.get(k) !== v) parent.set(k, k) })
            }
        }

        const opaqueAssigned = (root: ts.Node) => {
            const visit = (n: ts.Node) => {
                if (ts.isBinaryExpression(n) && ASSIGN_OPS.has(n.operatorToken.kind)) {
                    const root = rootIdent(n.left)
                    if (root) opaque(root)
                } else if ((ts.isPostfixUnaryExpression(n) || ts.isPrefixUnaryExpression(n)) &&
                    (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken)) {
                    const root = rootIdent(n.operand)
                    if (root) opaque(root)
                }
                ts.forEachChild(n, visit)
            }
            visit(root)
        }

        const rootIdent = (n: ts.Node): string | undefined => {
            while (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) n = n.expression
            return ts.isIdentifier(n) ? n.text : undefined
        }

        const resolveDecl = (call: ts.CallExpression): ts.Declaration | undefined => {
            try {
                const sym = checker.getSymbolAtLocation(call.expression)
                const target = sym && sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym
                return target?.declarations?.[0]
            } catch {
                return undefined
            }
        }

        // source text with known variables replaced by their current values
        const resolveText = (expr: ts.Node, sf: ts.SourceFile): string => {
            if (isAnyFn(expr)) return '<fn>'
            const start = expr.getStart(sf)
            let text = expr.getText(sf)
            const repl: { s: number; e: number; v: string }[] = []
            const visit = (n: ts.Node) => {
                if (isAnyFn(n)) {
                    repl.push({ s: n.getStart(sf) - start, e: n.getEnd() - start, v: '<fn>' })
                    return
                }
                if (ts.isIdentifier(n)) {
                    const p = n.parent
                    const isKey = (ts.isPropertyAccessExpression(p) && p.name === n) ||
                        (ts.isPropertyAssignment(p) && p.name === n)
                    const v = scope.get(n.text)
                    if (!isKey && v !== undefined && v !== n.text) {
                        repl.push({
                            s: n.getStart(sf) - start,
                            e: n.getEnd() - start,
                            v: ts.isShorthandPropertyAssignment(p) ? `${n.text}: ${v}` : v,
                        })
                    }
                }
                ts.forEachChild(n, visit)
            }
            visit(expr)
            repl.sort((a, b) => b.s - a.s).forEach(r => { text = text.slice(0, r.s) + r.v + text.slice(r.e) })
            return text.replace(/\s+/g, ' ')
        }

        const classifyCall = (call: ts.CallExpression, sf: ts.SourceFile): Step['coreAction'] => {
            const callee = call.expression
            if (ts.isIdentifier(callee)) return API_FNS.test(callee.text) ? 'api_call' : undefined
            if (ts.isPropertyAccessExpression(callee)) {
                const method = callee.name.text
                const receiver = callee.expression.getText(sf)
                if (API_RECEIVERS.test(receiver) && HTTP_METHODS.test(method)) return 'api_call'
                if (method === 'save') return 'db_save'
                if (DB_METHODS.test(method) && DB_RECEIVERS.test(receiver)) {
                    if (method === 'query' || method === 'execute' || method === 'run') {
                        const first = call.arguments[0]
                        return first && SQL_WRITE.test(first.getText(sf)) ? 'db_save' : undefined
                    }
                    return 'db_save'
                }
            }
            return undefined
        }

        const mk = (sf: ts.SourceFile, kind: StepKind, node: ts.Node, value: string, extra: Partial<Step> = {}): Step => ({
            file: sf.fileName,
            kind,
            line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
            endLine: sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1,
            value,
            ...extra,
            children: [],
        })

        // Emits the steps an expression performs (calls, awaits, ternaries) in evaluation order.
        const collect = (n: ts.Node, sf: ts.SourceFile, out: Step[]): void => {
            if (isAnyFn(n)) {
                const step = mk(sf, 'declare', n, '<anonymous>', { declType: 'fn', ...fnMeta(n) })
                fnBody(n, sf, step.children)
                out.push(step)
                return
            }
            if (ts.isConditionalExpression(n)) {
                collect(n.condition, sf, out)
                const step = mk(sf, 'branch', n, resolveText(n.condition, sf))
                step.children = block(() => { const o: Step[] = []; collect(n.whenTrue, sf, o); return o })
                step.else = block(() => { const o: Step[] = []; collect(n.whenFalse, sf, o); return o })
                out.push(step)
                return
            }
            if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
                collect(n.expression, sf, out)
                const args = n.arguments ?? []
                args.forEach(a => { if (!isAnyFn(a)) collect(a, sf, out) })
                const argText = args.map(a => resolveText(a, sf))
                const calleeText = (ts.isNewExpression(n) ? 'new ' : '') + resolveText(n.expression, sf)
                const step = mk(sf, 'call', n, `${calleeText}(${argText.join(', ')})`, { callee: calleeText, args: argText })
                if (ts.isCallExpression(n)) {
                    const decl = resolveDecl(n)
                    if (decl) step.isExternal = decl.getSourceFile() !== sf
                    const core = classifyCall(n, sf)
                    if (core) step.coreAction = core
                }
                args.forEach(a => { if (isAnyFn(a)) fnBody(a, sf, step.children) })
                out.push(step)
                return
            }
            if (ts.isAwaitExpression(n)) {
                collect(n.expression, sf, out)
                out.push(mk(sf, 'await', n, resolveText(n.expression, sf)))
                return
            }
            ts.forEachChild(n, c => collect(c, sf, out))
        }

        const isCallLike = (e: ts.Expression) => {
            const u = unwrap(e)
            return ts.isCallExpression(u) || ts.isNewExpression(u)
        }

        function fnBody(fn: ts.FunctionLikeDeclaration, sf: ts.SourceFile, out: Step[]) {
            block(() => {
                fn.parameters.forEach(p => bindingNames(p.name).forEach(opaque))
                if (!fn.body) return
                if (ts.isBlock(fn.body)) {
                    fn.body.statements.forEach(s => statement(s, sf, out))
                } else {
                    emitReturn(fn.body, fn.body, sf, out)
                }
            })
        }

        const emitReturn = (node: ts.Node, expr: ts.Expression | undefined, sf: ts.SourceFile, out: Step[]) => {
            if (expr) collect(expr, sf, out)
            out.push(mk(sf, 'return', node, expr ? resolveText(expr, sf) : '', { coreAction: 'return' }))
        }

        // `target = init` / `const target = init`
        const bind = (node: ts.Node, targetNode: ts.Node, init: ts.Expression | undefined, declares: boolean,
            sf: ts.SourceFile, out: Step[], exported = false) => {
            const target = targetNode.getText(sf)
            const names = ts.isIdentifier(targetNode) || ts.isObjectBindingPattern(targetNode) || ts.isArrayBindingPattern(targetNode)
                ? (ts.isIdentifier(targetNode) ? [targetNode.text] : bindingNames(targetNode as ts.BindingName))
                : []
            const root = rootIdent(targetNode)
            if (!init) {
                out.push(mk(sf, 'declare', node, target, { declType: 'var', target, exported: exported || undefined }))
                names.forEach(opaque)
                return
            }
            const u = unwrap(init)
            if (isFnExpr(u)) {
                const step = mk(sf, 'declare', node, target, { declType: 'fn', exported: exported || undefined, ...fnMeta(u) })
                fnBody(u, sf, step.children)
                out.push(step)
                names.forEach(opaque)
                return
            }
            collect(init, sf, out)
            const value = resolveText(init, sf)
            if (isCallLike(init)) {
                out.push(mk(sf, 'result', node, resolveText(u, sf), {
                    target,
                    declType: declares ? 'var' : undefined,
                    exported: exported || undefined,
                }))
                names.forEach(opaque)
            } else {
                out.push(mk(sf, declares ? 'declare' : 'assign', node, value, {
                    target,
                    declType: declares ? 'var' : undefined,
                    exported: exported || undefined,
                }))
                if (names.length === 1 && ts.isIdentifier(targetNode)) scope.set(names[0], value)
                else names.forEach(opaque)
            }
            if (!declares && root && !ts.isIdentifier(targetNode)) opaque(root)
        }

        const sub = (stmt: ts.Statement | undefined, sf: ts.SourceFile): Step[] =>
            stmt ? block(() => { const o: Step[] = []; statement(stmt, sf, o); return o }) : []

        const header = (node: ts.Node, body: ts.Node, sf: ts.SourceFile) =>
            sf.text.slice(node.getStart(sf), body.getStart(sf)).replace(/\s+/g, ' ').trim()

        function statement(node: ts.Node, sf: ts.SourceFile, out: Step[]): void {
            const exported = ts.canHaveModifiers(node) &&
                !!ts.getModifiers(node)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)

            if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node)) {
                out.push(mk(sf, 'declare', node, node.getText(sf).replace(/\s+/g, ' '), { declType: 'import' }))
            } else if (ts.isExportAssignment(node)) {
                collect(node.expression, sf, out)
                out.push(mk(sf, 'declare', node, resolveText(node, sf).split('\n')[0], { declType: 'export' }))
            } else if (ts.isExportDeclaration(node)) {
                out.push(mk(sf, 'declare', node, node.getText(sf).split('\n')[0], { declType: 'export' }))
            } else if (ts.isFunctionDeclaration(node)) {
                const step = mk(sf, 'declare', node, node.name?.text ?? 'default', { declType: 'fn', exported: exported || undefined, ...fnMeta(node) })
                fnBody(node, sf, step.children)
                if (node.name) opaque(node.name.text)
                out.push(step)
            } else if (ts.isClassDeclaration(node)) {
                const step = mk(sf, 'declare', node, node.name?.text ?? 'default', { declType: 'class', exported: exported || undefined })
                if (node.name) opaque(node.name.text)
                node.members.forEach(m => {
                    if (ts.isConstructorDeclaration(m)) {
                        const f = mk(sf, 'declare', m, 'constructor', { declType: 'fn', ...fnMeta(m) })
                        fnBody(m, sf, f.children)
                        step.children.push(f)
                    } else if (ts.isMethodDeclaration(m) || ts.isGetAccessor(m) || ts.isSetAccessor(m)) {
                        const f = mk(sf, 'declare', m, m.name.getText(sf), { declType: 'fn', ...fnMeta(m) })
                        fnBody(m, sf, f.children)
                        step.children.push(f)
                    } else if (ts.isPropertyDeclaration(m)) {
                        block(() => bind(m, m.name, m.initializer, true, sf, step.children))
                    }
                })
                out.push(step)
            } else if (ts.isVariableStatement(node)) {
                node.declarationList.declarations.forEach(d => bind(d, d.name, d.initializer, true, sf, out, exported))
            } else if (ts.isExpressionStatement(node)) {
                const e = unwrap(node.expression)
                if (ts.isBinaryExpression(e) && ASSIGN_OPS.has(e.operatorToken.kind)) {
                    if (e.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
                        bind(node, e.left, e.right, false, sf, out)
                    } else {
                        collect(e.right, sf, out)
                        out.push(mk(sf, 'assign', node, resolveText(e, sf), { target: e.left.getText(sf) }))
                        const root = rootIdent(e.left)
                        if (root) opaque(root)
                    }
                } else if (ts.isPostfixUnaryExpression(e) || ts.isPrefixUnaryExpression(e)) {
                    out.push(mk(sf, 'assign', node, resolveText(e, sf), { target: e.operand.getText(sf) }))
                    const root = rootIdent(e.operand)
                    if (root) opaque(root)
                } else {
                    collect(node.expression, sf, out)
                }
            } else if (ts.isReturnStatement(node)) {
                emitReturn(node, node.expression, sf, out)
            } else if (ts.isThrowStatement(node)) {
                collect(node.expression, sf, out)
                out.push(mk(sf, 'throw', node, resolveText(node.expression, sf)))
            } else if (ts.isIfStatement(node)) {
                collect(node.expression, sf, out)
                const step = mk(sf, 'branch', node, resolveText(node.expression, sf))
                step.children = sub(node.thenStatement, sf)
                if (node.elseStatement) step.else = sub(node.elseStatement, sf)
                out.push(step)
            } else if (ts.isSwitchStatement(node)) {
                collect(node.expression, sf, out)
                const step = mk(sf, 'branch', node, `switch (${resolveText(node.expression, sf)})`)
                node.caseBlock.clauses.forEach(c => {
                    if (ts.isCaseClause(c)) collect(c.expression, sf, step.children)
                    const cs = mk(sf, 'branch', c, ts.isCaseClause(c) ? `case ${resolveText(c.expression, sf)}` : 'default')
                    cs.children = block(() => {
                        const o: Step[] = []
                        c.statements.forEach(s => statement(s, sf, o))
                        return o
                    })
                    step.children.push(cs)
                })
                out.push(step)
            } else if (ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node) ||
                ts.isWhileStatement(node) || ts.isDoStatement(node)) {
                if (ts.isForStatement(node)) {
                    if (node.initializer) {
                        if (ts.isVariableDeclarationList(node.initializer)) {
                            node.initializer.declarations.forEach(d => bind(d, d.name, d.initializer, true, sf, out))
                        } else {
                            collect(node.initializer, sf, out)
                        }
                    }
                    if (node.condition) collect(node.condition, sf, out)
                } else if (ts.isForOfStatement(node) || ts.isForInStatement(node)) {
                    collect(node.expression, sf, out)
                    if (ts.isVariableDeclarationList(node.initializer)) {
                        node.initializer.declarations.forEach(d => bindingNames(d.name).forEach(opaque))
                    }
                } else {
                    collect(node.expression, sf, out)
                }
                opaqueAssigned(node)
                const step = mk(sf, 'loop', node, header(node, node.statement, sf))
                step.children = sub(node.statement, sf)
                out.push(step)
            } else if (ts.isTryStatement(node)) {
                const step = mk(sf, 'try', node, 'try')
                step.children = sub(node.tryBlock, sf)
                if (node.catchClause) {
                    const cc = node.catchClause
                    step.catch = block(() => {
                        if (cc.variableDeclaration) bindingNames(cc.variableDeclaration.name).forEach(opaque)
                        const o: Step[] = []
                        cc.block.statements.forEach(s => statement(s, sf, o))
                        return o
                    })
                }
                if (node.finallyBlock) step.finally = sub(node.finallyBlock, sf)
                out.push(step)
            } else if (ts.isBlock(node)) {
                node.statements.forEach(s => statement(s, sf, out))
            } else if (ts.isLabeledStatement(node)) {
                statement(node.statement, sf, out)
            }
        }

        this.filesToCheck.forEach(fp => {
            const source = program.getSourceFile(fp)
            if (!source) {
                console.warn(`Cannot load source file: ${fp}`)
                return
            }
            scope = new Map()
            const steps: Step[] = []
            source.statements.forEach(s => statement(s, source, steps))
            result.set(fp, steps)
        })

        this.result = result
        return result
    }

    // JSON array, one item per file: [{ file, data: Step[] }]
    get(): string {
        const result = this.result ?? this.transformer()
        return JSON.stringify(
            Array.from(result, ([file, data]) => ({ file, data })),
            null,
            2
        )
    }
}
