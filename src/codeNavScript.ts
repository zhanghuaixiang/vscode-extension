import { parse } from '@babel/parser';
import * as t from '@babel/types';
import { CodeNavResult, makeNode, NavNode, SourceMap } from './codeNavTypes';

export interface ScriptBlock {
    content: string;
    offset: number;
    lang?: string;
}

interface FunctionBody {
    node: NavNode;
    body: t.Node;
    params: (t.FunctionParameter | t.TSParameterProperty)[];
    optionsMethod: boolean;
}

interface PendingExport {
    node: NavNode;
    local?: string;
    target?: NavNode;
    external?: boolean;
}

const lifecycle = new Set([
    'beforeCreate', 'created', 'beforeMount', 'mounted', 'beforeUpdate', 'updated',
    'beforeDestroy', 'destroyed', 'beforeUnmount', 'unmounted', 'activated',
    'deactivated', 'errorCaptured', 'serverPrefetch'
]);

function keyName(key: t.Node, computed = false): string | undefined {
    if (computed) {
        return undefined;
    }
    if (t.isIdentifier(key)) {
        return key.name;
    }
    if (t.isStringLiteral(key) || t.isNumericLiteral(key)) {
        return String(key.value);
    }
    return undefined;
}

function propertyName(property: t.ObjectProperty | t.ObjectMethod): string | undefined {
    return keyName(property.key, property.computed);
}

function functionPart(node: t.Node): {
    body: t.Node; params: (t.FunctionParameter | t.TSParameterProperty)[]
} | undefined {
    if (t.isFunctionDeclaration(node) || t.isFunctionExpression(node)
        || t.isArrowFunctionExpression(node) || t.isObjectMethod(node) || t.isClassMethod(node)) {
        return { body: node.body, params: node.params };
    }
    return undefined;
}

function visit(node: t.Node, callback: (child: t.Node) => void): void {
    callback(node);
    for (const key of t.VISITOR_KEYS[node.type] ?? []) {
        const value: unknown = (node as unknown as Record<string, unknown>)[key];
        for (const child of Array.isArray(value) ? value : [value]) {
            if (!child || typeof child !== 'object' || !('type' in child)) {
                continue;
            }
            const next = child as t.Node;
            if (t.isFunction(next) || t.isClass(next)) {
                callback(next);
                continue;
            }
            visit(next, callback);
        }
    }
}

export class ScriptAnalyzer {
    private readonly bindings = new Map<string, NavNode[]>();
    private readonly methods = new Map<string, NavNode[]>();
    private readonly states = new Map<string, NavNode[]>();
    private readonly bodies: FunctionBody[] = [];
    private readonly pendingExports: PendingExport[] = [];

    constructor(
        private readonly result: CodeNavResult,
        private readonly sourceMap: SourceMap
    ) {}

    analyze(blocks: ScriptBlock[]): void {
        for (const block of blocks) {
            this.parseBlock(block);
        }
        this.resolveExports();
        for (const body of this.bodies) {
            this.scanBody(body);
        }
        this.groupMethods();
        this.result.guide.state = this.result.script.data.slice();
    }

    resolveHandler(name: string): NavNode | undefined {
        const matches = [
            ...(this.methods.get(name) ?? []),
            ...(this.bindings.get(name) ?? []).filter(node => node.kind === 'function')
        ];
        return matches.length === 1 ? matches[0] : undefined;
    }

    private add(kind: NavNode['kind'], name: string, node: t.Node, offset: number): NavNode {
        const start = offset + (node.start ?? 0);
        const end = offset + (node.end ?? node.start ?? 0);
        const item = makeNode(kind, name, start, end, this.sourceMap);
        this.result.nodes.push(item);
        return item;
    }

    private bind(name: string, node: NavNode, method = false): void {
        const bindings = method ? this.methods : this.bindings;
        bindings.set(name, [...(bindings.get(name) ?? []), node]);
    }

    private addBody(body: FunctionBody, offset: number): void {
        this.bodies.push(body);
        this.bodyOffsets.set(body.node.id, offset);
    }

    private parseBlock(block: ScriptBlock): void {
        const section = makeNode('script', block.lang || 'js', block.offset,
            block.offset + block.content.length, this.sourceMap);
        this.result.nodes.push(section);
        let ast: ReturnType<typeof parse>;
        try {
            const plugins: ('typescript' | 'jsx')[] =
                block.lang === 'ts' ? ['typescript'] :
                    block.lang === 'tsx' ? ['typescript', 'jsx'] : ['jsx'];
            ast = parse(block.content, { sourceType: 'unambiguous', plugins, errorRecovery: true });
        } catch (error) {
            const issue = error as Error & { pos?: number };
            this.result.errors.push({
                message: issue.message,
                line: this.sourceMap.position(block.offset + (issue.pos ?? 0)).line,
                block: 'script'
            });
            return;
        }
        for (const error of ast.errors ?? []) {
            this.result.errors.push({
                message: error.message,
                line: this.sourceMap.position(block.offset + (error.pos ?? 0)).line,
                block: 'script'
            });
        }
        for (const statement of ast.program.body) {
            this.statement(statement, block.offset);
        }
    }

    private statement(statement: t.Statement | t.ModuleDeclaration, offset: number): void {
        if (t.isImportDeclaration(statement)) {
            this.result.imports.push(this.add('import', statement.source.value, statement, offset).id);
        } else if (t.isExportNamedDeclaration(statement)) {
            if (statement.declaration && !statement.exportKind?.includes('type')) {
                this.declaration(statement.declaration, offset);
                const names = this.declaredNames(statement.declaration);
                for (const name of names) {
                    this.exportAt(name, statement, offset, name);
                }
                if (!names.length) {
                    this.exportAt(`binding@${statement.loc?.start.line}`, statement, offset);
                }
            }
            if (statement.exportKind !== 'type') {
                for (const specifier of statement.specifiers) {
                    if (t.isExportSpecifier(specifier) && specifier.exportKind !== 'type') {
                        this.exportAt(
                            keyName(specifier.exported) ?? 'unknown', specifier, offset,
                            specifier.local.name, Boolean(statement.source)
                        );
                    }
                }
            }
        } else if (t.isExportDefaultDeclaration(statement)) {
            const value = statement.declaration;
            let target: NavNode | undefined;
            if (t.isObjectExpression(value) || t.isCallExpression(value)) {
                const options = t.isObjectExpression(value) ? value : value.arguments[0];
                if (options && t.isObjectExpression(options)) {
                    if (this.result.fileType === 'vue') {
                        this.readOptions(options, offset);
                    }
                    if (t.isObjectExpression(value)) {
                        target = this.add('variable', this.result.script.name ?? 'default object', options, offset);
                        this.result.script.declarations.push(target.id);
                        if (this.result.fileType === 'js') {
                            target.children = this.objectMethods(options, offset);
                        }
                    }
                }
            } else if (t.isFunctionExpression(value) || t.isArrowFunctionExpression(value)) {
                target = this.add('function',
                    t.isFunctionExpression(value) ? value.id?.name ?? 'default' : 'default', value, offset);
                this.result.script.declarations.push(target.id);
                this.addBody({
                    node: target, body: value.body, params: value.params, optionsMethod: false
                }, offset);
            } else if (t.isFunctionDeclaration(value) || t.isClassDeclaration(value)) {
                if (value.id) {
                    this.declaration(value, offset);
                } else if (t.isFunctionDeclaration(value)) {
                    target = this.add('function', 'default', value, offset);
                    this.result.script.declarations.push(target.id);
                    this.addBody({ node: target, body: value.body, params: value.params, optionsMethod: false }, offset);
                } else {
                    target = this.add('class', 'default', value, offset);
                    this.result.script.declarations.push(target.id);
                    target.children = [];
                    for (const member of value.body.body) {
                        if (t.isClassMethod(member)) {
                            const name = keyName(member.key, member.computed) ?? `method@${member.loc?.start.line}`;
                            const method = this.add('classMethod', name, member, offset);
                            target.children.push(method.id);
                            this.addBody({
                                node: method, body: member.body, params: member.params, optionsMethod: false
                            }, offset);
                        }
                    }
                }
            }
            const local = t.isIdentifier(value) ? value.name
                : t.isFunctionDeclaration(value) || t.isClassDeclaration(value) ? value.id?.name : undefined;
            this.pendingExports.push({
                node: this.add('export', 'default', statement, offset),
                local,
                target,
                external: !local && !(t.isObjectExpression(value) || t.isCallExpression(value))
            });
        } else if (t.isExportAllDeclaration(statement)) {
            this.pendingExports.push({
                node: this.add('export', '*', statement, offset), external: true
            });
        } else if (t.isExpressionStatement(statement) && t.isAssignmentExpression(statement.expression)) {
            this.commonJsExport(statement.expression, offset);
        } else if (t.isDeclaration(statement)) {
            this.declaration(statement, offset);
        }
    }

    private declaredNames(declaration: t.Declaration): string[] {
        if (t.isFunctionDeclaration(declaration) || t.isClassDeclaration(declaration)) {
            return declaration.id ? [declaration.id.name] : [];
        }
        return t.isVariableDeclaration(declaration)
            ? declaration.declarations.filter(item => t.isIdentifier(item.id))
                .map(item => (item.id as t.Identifier).name) : [];
    }

    private declaration(declaration: t.Declaration, offset: number): void {
        if (t.isFunctionDeclaration(declaration) && declaration.id) {
            const item = this.add('function', declaration.id.name, declaration, offset);
            this.result.script.declarations.push(item.id);
            this.bind(item.name, item);
            this.addBody({ node: item, body: declaration.body, params: declaration.params, optionsMethod: false }, offset);
        } else if (t.isClassDeclaration(declaration) && declaration.id) {
            const item = this.add('class', declaration.id.name, declaration, offset);
            this.result.script.declarations.push(item.id);
            this.bind(item.name, item);
            item.children = [];
            for (const member of declaration.body.body) {
                if (t.isClassMethod(member)) {
                    const name = keyName(member.key, member.computed) ?? `method@${member.loc?.start.line}`;
                    const method = this.add('classMethod', name, member, offset);
                    item.children.push(method.id);
                    this.addBody({ node: method, body: member.body, params: member.params, optionsMethod: false }, offset);
                }
            }
        } else if (t.isVariableDeclaration(declaration)) {
            for (const variable of declaration.declarations) {
                const name = t.isIdentifier(variable.id) ? variable.id.name : `binding@${variable.loc?.start.line}`;
                const part = variable.init && functionPart(variable.init);
                const item = this.add(part ? 'function' : 'variable', name, variable, offset);
                this.result.script.declarations.push(item.id);
                if (t.isIdentifier(variable.id)) {
                    this.bind(name, item);
                }
                if (part) {
                    this.addBody({ node: item, ...part, optionsMethod: false }, offset);
                }
                if (variable.init && t.isCallExpression(variable.init)
                    && t.isIdentifier(variable.init.callee, { name: 'require' })
                    && t.isStringLiteral(variable.init.arguments[0])) {
                    this.result.imports.push(this.add('import', variable.init.arguments[0].value, variable, offset).id);
                }
                if (variable.init && t.isObjectExpression(variable.init)) {
                    item.children = this.objectMethods(variable.init, offset);
                }
            }
        }
    }

    private objectMethods(object: t.ObjectExpression, offset: number): string[] {
        const children: string[] = [];
        for (const property of object.properties) {
            if (!t.isObjectMethod(property) && !t.isObjectProperty(property)) {
                continue;
            }
            const part = t.isObjectMethod(property) ? functionPart(property) : functionPart(property.value);
            if (!part) {
                continue;
            }
            const name = propertyName(property) ?? `method@${property.loc?.start.line}`;
            const method = this.add('method', name, property, offset);
            children.push(method.id);
            this.addBody({ node: method, ...part, optionsMethod: false }, offset);
        }
        return children;
    }

    private readOptions(object: t.ObjectExpression, offset: number): void {
        for (const property of object.properties) {
            if (!t.isObjectMethod(property) && !t.isObjectProperty(property)) {
                continue;
            }
            const name = propertyName(property);
            if (!name) {
                continue;
            }
            if (name === 'name' && t.isObjectProperty(property) && t.isStringLiteral(property.value)) {
                this.result.meta.componentName = property.value.value;
                this.result.script.name = property.value.value;
                this.add('component', property.value.value, property, offset);
            } else if (name === 'props' && t.isObjectProperty(property)) {
                if (t.isObjectExpression(property.value)) {
                    this.readFields(property.value, offset, 'prop', this.result.script.props);
                } else if (t.isArrayExpression(property.value)) {
                    for (const value of property.value.elements) {
                        if (value && t.isStringLiteral(value)) {
                            this.result.script.props.push(this.add('prop', value.value, value, offset).id);
                        }
                    }
                }
            } else if (name === 'data') {
                const part = t.isObjectMethod(property) ? functionPart(property) : functionPart(property.value);
                if (part && t.isBlockStatement(part.body)) {
                    for (const statement of part.body.body) {
                        if (t.isReturnStatement(statement) && statement.argument && t.isObjectExpression(statement.argument)) {
                            this.readFields(statement.argument, offset, 'state', this.result.script.data);
                        }
                    }
                }
            } else if (['computed', 'watch', 'methods'].includes(name) && t.isObjectProperty(property)
                && t.isObjectExpression(property.value)) {
                const kind = name === 'computed' ? 'computed' : name === 'watch' ? 'watch' : 'method';
                const section = name === 'computed' ? this.result.script.computed
                    : name === 'watch' ? this.result.script.watch : this.result.script.declarations;
                for (const member of property.value.properties) {
                    if (!t.isObjectMethod(member) && !t.isObjectProperty(member)) {
                        continue;
                    }
                    const memberName = propertyName(member);
                    const part = t.isObjectMethod(member) ? functionPart(member) : functionPart(member.value);
                    if (!memberName) {
                        continue;
                    }
                    const item = this.add(kind, memberName, member, offset);
                    section.push(item.id);
                    if (name === 'methods' && part) {
                        this.bind(memberName, item, true);
                    }
                    if (part) {
                        this.addBody({
                            node: item, ...part,
                            optionsMethod: !t.isObjectProperty(member) || !t.isArrowFunctionExpression(member.value)
                        }, offset);
                    } else if (t.isObjectProperty(member) && t.isObjectExpression(member.value)) {
                        item.children = this.objectMethods(member.value, offset);
                    }
                }
            } else if (lifecycle.has(name)) {
                const part = t.isObjectMethod(property) ? functionPart(property) : functionPart(property.value);
                if (part) {
                    const item = this.add('hook', name, property, offset);
                    this.result.script.hooks.push(item.id);
                    this.addBody({ node: item, ...part, optionsMethod: true }, offset);
                }
            }
        }
    }

    private readFields(
        object: t.ObjectExpression, offset: number, kind: 'prop' | 'state', output: string[]
    ): void {
        for (const property of object.properties) {
            if (!t.isObjectProperty(property) && !t.isObjectMethod(property)) {
                continue;
            }
            const name = propertyName(property);
            if (name) {
                const item = this.add(kind, name, property, offset);
                output.push(item.id);
                if (kind === 'state') {
                    this.states.set(name, [...(this.states.get(name) ?? []), item]);
                }
            }
        }
    }

    private exportAt(name: string, source: t.Node, offset: number, local?: string, external = false): void {
        this.pendingExports.push({ node: this.add('export', name, source, offset), local, external });
    }

    private commonJsExport(expression: t.AssignmentExpression, offset: number): void {
        const left = expression.left;
        if (!t.isMemberExpression(left) || left.computed) {
            return;
        }
        const member = keyName(left.property);
        let name: string | undefined;
        if (t.isIdentifier(left.object, { name: 'exports' })) {
            name = member;
        } else if (t.isMemberExpression(left.object) && !left.object.computed
            && t.isIdentifier(left.object.object, { name: 'module' })
            && t.isIdentifier(left.object.property, { name: 'exports' })) {
            name = member;
        } else if (t.isIdentifier(left.object, { name: 'module' }) && member === 'exports') {
            name = 'default';
        }
        if (!name) {
            return;
        }
        const right = expression.right;
        if (name === 'default' && t.isObjectExpression(right) && this.result.fileType === 'vue') {
            this.readOptions(right, offset);
        }
        const part = functionPart(right);
        let target: NavNode | undefined;
        if (part) {
            target = this.add('function', name, right, offset);
            this.result.script.declarations.push(target.id);
            this.addBody({ node: target, ...part, optionsMethod: false }, offset);
        } else if (name === 'default' && t.isObjectExpression(right)) {
            target = this.add('variable', this.result.script.name ?? 'default object', right, offset);
            this.result.script.declarations.push(target.id);
            if (this.result.fileType === 'js') {
                target.children = this.objectMethods(right, offset);
            }
        }
        this.pendingExports.push({
            node: this.add('export', name, expression, offset),
            local: t.isIdentifier(right) ? right.name : undefined, target
        });
    }

    private resolveExports(): void {
        for (const pending of this.pendingExports) {
            this.result.script.exports.push(pending.node.id);
            this.result.guide.entries.push(pending.node.id);
            const matches = pending.local ? this.bindings.get(pending.local) ?? [] : [];
            const target = pending.target ?? (matches.length === 1 ? matches[0] : undefined);
            this.result.paths.push({
                from: pending.node.id,
                to: target?.id,
                targetName: pending.local,
                type: 'exports',
                certainty: target ? 'certain' : 'unresolved',
                evidence: pending.node.range,
                reason: target ? undefined : pending.external ? '跨文件导出或动态表达式'
                    : '未找到唯一的本文件声明'
            });
        }
    }

    private scanBody(body: FunctionBody): void {
        const localNames = new Set(body.params.flatMap(parameter => t.isIdentifier(parameter) ? [parameter.name] : []));
        visit(body.body, node => {
            if (t.isVariableDeclarator(node) && t.isIdentifier(node.id)) {
                localNames.add(node.id.name);
            }
            if (t.isFunctionDeclaration(node) && node.id) {
                localNames.add(node.id.name);
            }
        });
        visit(body.body, node => {
            if (t.isCallExpression(node) || t.isOptionalCallExpression(node)) {
                const callee = node.callee;
                let name: string | undefined;
                let matches: NavNode[] = [];
                if (t.isIdentifier(callee)) {
                    name = callee.name;
                    matches = localNames.has(name) ? [] : this.bindings.get(name) ?? [];
                } else if (t.isMemberExpression(callee) && !callee.computed
                    && t.isThisExpression(callee.object) && t.isIdentifier(callee.property)) {
                    name = callee.property.name;
                    matches = body.optionsMethod ? this.methods.get(name) ?? [] : [];
                }
                const target = !node.optional && matches.length === 1
                    && (matches[0].kind === 'function' || matches[0].kind === 'method')
                    ? matches[0] : undefined;
                this.result.paths.push({
                    from: body.node.id, to: target?.id, targetName: name,
                    type: 'calls', certainty: target ? 'certain' : 'unresolved',
                    evidence: this.sourceMap.range(
                        (node.start ?? 0) + this.offsetFor(body.node),
                        (node.end ?? 0) + this.offsetFor(body.node)
                    ),
                    reason: target ? undefined : '动态调用、外部依赖或无法唯一解析'
                });
            } else if (t.isAssignmentExpression(node) || t.isUpdateExpression(node)) {
                const left = t.isAssignmentExpression(node) ? node.left : node.argument;
                if (!t.isMemberExpression(left) || left.computed || !t.isThisExpression(left.object)
                    || !t.isIdentifier(left.property)) {
                    return;
                }
                const name = left.property.name;
                const matches = this.states.get(name) ?? [];
                const target = body.optionsMethod && matches.length === 1 ? matches[0] : undefined;
                this.result.paths.push({
                    from: body.node.id, to: target?.id, targetName: name,
                    type: 'writes', certainty: target ? 'certain' : 'unresolved',
                    evidence: this.sourceMap.range(
                        (left.start ?? 0) + this.offsetFor(body.node),
                        (left.end ?? 0) + this.offsetFor(body.node)
                    ),
                    reason: target ? undefined : '未找到唯一的本文件状态声明'
                });
            } else if (t.isReturnStatement(node)) {
                const offset = this.offsetFor(body.node);
                const item = this.add('return', 'return', node, offset);
                this.result.paths.push({
                    from: body.node.id, to: item.id, type: 'returns', certainty: 'certain',
                    evidence: item.range
                });
            }
        });
    }

    private offsetFor(owner: NavNode): number {
        return this.bodyOffsets.get(owner.id) ?? 0;
    }

    private readonly bodyOffsets = new Map<string, number>();

    private groupMethods(): void {
        const groups = new Map<string, { label: string; rule: string; methods: string[] }>();
        for (const body of this.bodies) {
            const name = body.node.name;
            const label = body.node.kind === 'hook' ? '生命周期/hooks'
                : /^(open|add|edit|create)/i.test(name) ? '打开与创建'
                    : /^(is|can|check|has)/i.test(name) ? '状态判定'
                        : '其它/uncategorized';
            const group = groups.get(label) ?? { label, rule: label === '其它/uncategorized' ? 'fallback' : 'name prefix', methods: [] };
            group.methods.push(body.node.id);
            groups.set(label, group);
        }
        this.result.script.groups = [...groups.values()];
    }
}
