import { parse } from '@babel/parser';
import * as t from '@babel/types';
import {
    CodeNavResult, CommentNote, DocComment, EmitTrigger, FunctionCard, FunctionRef, makeNode, NavNode,
    PropContract, SourceMap, StateFlow, TimelineStep
} from './codeNavTypes';

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
    fn?: t.Node;
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

/** `<script setup>` 里返回响应式状态的内置工厂。 */
const stateFactories = new Set([
    'ref', 'shallowRef', 'reactive', 'shallowReactive', 'toRef', 'toRefs', 'customRef'
]);

const templateKeywords = new Set([
    'this', 'true', 'false', 'null', 'undefined', 'new', 'typeof', 'instanceof', 'in', 'of',
    'return', 'function', 'void', 'delete', 'yield', 'await', 'async', 'let', 'const', 'var'
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
    body: t.Node; params: (t.FunctionParameter | t.TSParameterProperty)[]; fn: t.Node;
} | undefined {
    if (t.isFunctionDeclaration(node) || t.isFunctionExpression(node)
        || t.isArrowFunctionExpression(node) || t.isObjectMethod(node) || t.isClassMethod(node)) {
        return { body: node.body, params: node.params, fn: node };
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

interface WalkEntry { node: t.Node; parent?: t.Node; grandparent?: t.Node; }

/** 判断标识符是否处于“被当作值读取”的位置，跳过赋值左侧、对象键与类型引用。 */
function isValueRead(node: t.Identifier, parent?: t.Node, grandparent?: t.Node): boolean {
    if (!parent) { return true; }
    if (t.isAssignmentExpression(parent) && parent.left === node) { return false; }
    if (t.isUpdateExpression(parent) && parent.argument === node) { return false; }
    if (t.isVariableDeclarator(parent) && parent.id === node) { return false; }
    if ((t.isFunctionDeclaration(parent) || t.isClassDeclaration(parent)) && parent.id === node) { return false; }
    if (t.isMemberExpression(parent) && !parent.computed) {
        const isTarget = Boolean(grandparent)
            && ((t.isAssignmentExpression(grandparent!) && grandparent!.left === parent)
                || (t.isUpdateExpression(grandparent!) && grandparent!.argument === parent));
        if (parent.property === node) {
            return !isTarget && t.isThisExpression(parent.object);
        }
        if (parent.object === node && isTarget) { return false; }
    }
    const holder = parent as { key?: t.Node; computed?: boolean };
    if ((t.isObjectProperty(parent) || t.isObjectMethod(parent) || t.isClassMethod(parent))
        && holder.key === node && !holder.computed) {
        return false;
    }
    if (t.isTSTypeAnnotation(parent) || t.isTSTypeReference(parent) || t.isTSQualifiedName(parent)
        || t.isTSTypeAliasDeclaration(parent) || t.isTSInterfaceDeclaration(parent)) {
        return false;
    }
    return true;
}

/** 收集一段代码里被读取的标识符，用于统计状态读取者。 */
function readIdentifiers(root: t.Node): t.Identifier[] {
    const found: t.Identifier[] = [];
    const stack: WalkEntry[] = [{ node: root }];
    while (stack.length) {
        const { node, parent, grandparent } = stack.pop()!;
        if (t.isIdentifier(node)) {
            if (isValueRead(node, parent, grandparent)) { found.push(node); }
            continue;
        }
        for (const key of t.VISITOR_KEYS[node.type] ?? []) {
            const value: unknown = (node as unknown as Record<string, unknown>)[key];
            for (const child of Array.isArray(value) ? value : [value]) {
                if (child && typeof child === 'object' && 'type' in child) {
                    stack.push({ node: child as t.Node, parent: node, grandparent: parent });
                }
            }
        }
    }
    return found;
}

function commentText(value: string): string {
    return value.split(/\r?\n/)
        .map(line => line.replace(/^\s*\*+\s?/, '').trim())
        .filter(Boolean)
        .join(' ').trim();
}

function markerKind(marker: string): CommentNote['kind'] {
    const upper = marker.toUpperCase();
    if (upper === 'FIXME' || upper === 'BUG') { return 'fixme'; }
    if (upper === 'HACK' || upper === 'XXX') { return 'hack'; }
    return 'todo';
}

/** 区分 JSDoc 正文与 `@param` 一类的标签，正文按原样保留，不做概括。 */
function parseDoc(values: string[], line: number): DocComment | undefined {
    const texts: string[] = [];
    const tags: { tag: string; text: string }[] = [];
    let current: { tag: string; text: string } | undefined;
    for (const value of values) {
        for (const raw of value.split(/\r?\n/)) {
            const clean = raw.replace(/^\s*\*+\s?/, '').trim();
            if (!clean) { continue; }
            const match = /^@([A-Za-z][\w-]*)\s*([\s\S]*)$/.exec(clean);
            if (match) {
                current = { tag: match[1].toLowerCase(), text: match[2].trim() };
                tags.push(current);
            } else if (current) {
                current.text = `${current.text} ${clean}`.trim();
            } else {
                texts.push(clean);
            }
        }
    }
    const text = texts.join(' ');
    if (!text && !tags.length) { return undefined; }
    return { text, line, tags };
}

export class ScriptAnalyzer {
    private readonly bindings = new Map<string, NavNode[]>();
    private readonly methods = new Map<string, NavNode[]>();
    private readonly states = new Map<string, NavNode[]>();
    /** 所有可被读写的具名值：prop / state / computed。 */
    private readonly observables = new Map<string, NavNode[]>();
    private readonly flows = new Map<string, StateFlow>();
    private readonly emitAliases = new Set<string>();
    private readonly declaredEmits = new Map<string, number>();
    private readonly emitTriggers = new Map<string, EmitTrigger[]>();
    private readonly typeAliases = new Map<string, t.TSType>();
    private readonly bodies: FunctionBody[] = [];
    private readonly pendingExports: PendingExport[] = [];
    private readonly documented = new Set<number>();
    private readonly bodyOffsets = new Map<string, number>();

    constructor(
        private readonly result: CodeNavResult,
        private readonly sourceMap: SourceMap,
        private readonly source: string
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
        this.finalizeContract();
        this.finalizeStructure();
    }

    resolveHandler(name: string): NavNode | undefined {
        const matches = [
            ...(this.methods.get(name) ?? []),
            ...(this.bindings.get(name) ?? []).filter(node => node.kind === 'function')
        ];
        return matches.length === 1 ? matches[0] : undefined;
    }

    private add(kind: NavNode['kind'], name: string, node: t.Node, offset: number): NavNode {
        return this.addRange(kind, name, offset + (node.start ?? 0), offset + (node.end ?? node.start ?? 0));
    }

    private addRange(kind: NavNode['kind'], name: string, start: number, end: number): NavNode {
        const item = makeNode(kind, name, start, end, this.sourceMap);
        this.result.nodes.push(item);
        return item;
    }

    private lineAt(offset: number, node: t.Node): number {
        return this.sourceMap.position(offset + (node.start ?? 0)).line;
    }

    private sourceSlice(node: t.Node, offset: number): string {
        const start = offset + (node.start ?? 0);
        const end = offset + (node.end ?? node.start ?? 0);
        return this.source.slice(start, end).replace(/\s+/g, ' ').trim();
    }

    /**
     * 只把紧贴节点上方且独占整行的注释算作它的作者说明；
     * 上一行末尾的行尾注释不归属该节点。
     */
    private docFor(node: t.Node | null | undefined, offset: number): DocComment | undefined {
        if (!node || node.start === null || node.start === undefined) { return undefined; }
        const comments = node.leadingComments;
        if (!comments?.length) { return undefined; }
        const picked: { start: number; value: string }[] = [];
        let nextLine = this.sourceMap.position(offset + node.start).line;
        for (let index = comments.length - 1; index >= 0; index--) {
            const comment = comments[index];
            const absolute = offset + (comment.start ?? 0);
            const startLine = this.sourceMap.position(absolute).line;
            const endLine = startLine + (comment.value.match(/\n/g)?.length ?? 0);
            if (endLine !== nextLine - 1 || !this.isOwnLine(absolute)) { break; }
            picked.unshift({ start: absolute, value: comment.value });
            nextLine = startLine;
        }
        if (!picked.length) { return undefined; }
        // TODO / FIXME 一类标记留给“待办与备注”，不当作函数说明。
        if (/^(TODO|FIXME|HACK|XXX|BUG)\b/i.test(commentText(picked[0].value))) { return undefined; }
        const doc = parseDoc(picked.map(item => item.value),
            this.sourceMap.position(picked[0].start).line);
        if (!doc) { return undefined; }
        for (const item of picked) { this.documented.add(item.start); }
        return doc;
    }

    private isOwnLine(absolute: number): boolean {
        const lineStart = this.source.lastIndexOf('\n', Math.max(absolute - 1, 0)) + 1;
        return this.source.slice(lineStart, absolute).trim() === '';
    }

    /** 记录 TODO / FIXME / HACK 与模板备注，正文按原文保留。 */
    recordComment(value: string, start: number, end: number, block: 'template' | 'script'): void {
        const text = commentText(value);
        if (!text) { return; }
        const marker = /^(TODO|FIXME|HACK|XXX|BUG)\b[:：]?\s*/i.exec(text);
        const node = this.addRange('comment', text, start, end);
        this.result.comments.push({
            id: node.id,
            kind: marker ? markerKind(marker[1]) : 'note',
            text: marker && text.length > marker[0].length ? text.slice(marker[0].length).trim() : text,
            line: node.range.startLine,
            block
        });
    }

    /** 记录本文件模板里声明的插槽。 */
    recordSlot(name: string, id: string, line: number, scoped: boolean): void {
        this.result.contract.slots.push({ name: name || 'default', id, line, scoped });
    }

    /** 从模板表达式里挑出对本文件状态 / prop / computed 的引用。 */
    recordTemplateExpression(expression: string, line: number, locals: Set<string>): void {
        const clean = expression.replace(/'[^']*'|"[^"]*"|`[^`]*`/g, ' ');
        const pattern = /[A-Za-z_$][\w$]*/g;
        const seen = new Set<string>();
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(clean))) {
            const name = match[0];
            if (seen.has(name) || locals.has(name) || templateKeywords.has(name)) { continue; }
            seen.add(name);
            for (const target of this.observables.get(name) ?? []) {
                const flow = this.flow(target.id, target.name);
                if (!flow.templateLines.includes(line)) {
                    flow.templateLines.push(line);
                    flow.templateLines.sort((left, right) => left - right);
                }
            }
        }
    }

    private observe(name: string, node: NavNode): void {
        this.observables.set(name, [...(this.observables.get(name) ?? []), node]);
    }

    private flow(id: string, name: string): StateFlow {
        let flow = this.flows.get(id);
        if (!flow) {
            flow = { id, name, reads: [], writes: [], watches: [], templateLines: [] };
            this.flows.set(id, flow);
        }
        return flow;
    }

    private addProp(node: NavNode, detail: Omit<PropContract, 'id' | 'name'>): void {
        this.result.contract.props.push({ id: node.id, name: node.name, ...detail });
        this.observe(node.name, node);
        this.flow(node.id, node.name);
    }

    private bind(name: string, node: NavNode, method = false): void {
        const bindings = method ? this.methods : this.bindings;
        bindings.set(name, [...(bindings.get(name) ?? []), node]);
    }

    private addBody(body: FunctionBody, offset: number): void {
        this.bodies.push(body);
        this.bodyOffsets.set(body.node.id, offset);
    }

    private offsetFor(owner: NavNode): number {
        return this.bodyOffsets.get(owner.id) ?? 0;
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
        this.registerTypes(ast.program.body);
        for (const statement of ast.program.body) {
            this.statement(statement, block.offset);
        }
        const first = ast.program.body[0];
        if (first && !this.result.doc) {
            this.result.doc = this.docFor(first, block.offset) ?? null;
        }
        for (const comment of ast.comments ?? []) {
            const absolute = block.offset + (comment.start ?? 0);
            if (this.documented.has(absolute)) { continue; }
            this.recordComment(comment.value, absolute,
                block.offset + (comment.end ?? comment.start ?? 0), 'script');
        }
    }

    /** 记录本文件里声明的 interface / type，供 `defineProps<Props>()` 解析。 */
    private registerTypes(body: t.Statement[]): void {
        for (const statement of body) {
            if (t.isTSInterfaceDeclaration(statement) && t.isIdentifier(statement.id)) {
                this.typeAliases.set(statement.id.name, statement.body as unknown as t.TSType);
            } else if (t.isTSTypeAliasDeclaration(statement) && t.isIdentifier(statement.id)) {
                this.typeAliases.set(statement.id.name, statement.typeAnnotation);
            }
        }
    }

    private resolveType(node: t.TSType | t.TSInterfaceBody): t.TSType | t.TSInterfaceBody {
        if (t.isTSTypeReference(node) && t.isIdentifier(node.typeName)) {
            return this.typeAliases.get(node.typeName.name) ?? node;
        }
        return node;
    }

    private typeParameter(call: t.CallExpression): t.TSType | undefined {
        const params = call.typeParameters?.params;
        return params && params.length ? params[0] : undefined;
    }

    private typeText(node: t.Node | null | undefined, offset: number): string | null {
        if (!node) { return null; }
        if (t.isIdentifier(node)) { return node.name; }
        if (t.isArrayExpression(node)) {
            const parts = node.elements
                .map(element => this.typeText(element as t.Node | null, offset))
                .filter((item): item is string => Boolean(item));
            return parts.length ? parts.join(' | ') : null;
        }
        if (t.isTSAsExpression(node) || t.isTSTypeAssertion(node)) {
            return this.sourceSlice(node.typeAnnotation, offset) || null;
        }
        if (t.isTSNonNullExpression(node)) { return this.typeText(node.expression, offset); }
        if (t.isStringLiteral(node)) { return node.value; }
        return this.sourceSlice(node, offset) || null;
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
                        target.doc = this.docFor(statement, offset);
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
                    this.addBody({ node: target, body: value.body, params: value.params, optionsMethod: false, fn: value }, offset);
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
                                node: method, body: member.body, params: member.params, optionsMethod: false, fn: member
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
        } else if (t.isExpressionStatement(statement) && t.isCallExpression(statement.expression)) {
            this.macroCall(statement.expression, offset);
        } else if (t.isDeclaration(statement)) {
            this.declaration(statement, offset);
        }
    }

    /** 处理 `<script setup>` 顶层的组合式 API 调用。 */
    private macroCall(call: t.CallExpression, offset: number): void {
        if (!t.isIdentifier(call.callee)) { return; }
        const name = call.callee.name;
        if (name === 'defineProps') { this.readDefineProps(call, offset); }
        else if (name === 'withDefaults') { this.readWithDefaults(call, offset); }
        else if (name === 'defineEmits') { this.readDefineEmits(call, offset); }
        else if (name === 'defineModel') { this.readDefineModel(call, offset); }
        else if (name === 'provide' || name === 'inject') { this.readInjectionCall(call, offset, name); }
        else if (name === 'watch') { this.readWatchCall(call, offset); }
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
            item.doc = this.docFor(declaration, offset);
            this.result.script.declarations.push(item.id);
            this.bind(item.name, item);
            this.addBody({ node: item, body: declaration.body, params: declaration.params, optionsMethod: false, fn: declaration }, offset);
        } else if (t.isClassDeclaration(declaration) && declaration.id) {
            const item = this.add('class', declaration.id.name, declaration, offset);
            item.doc = this.docFor(declaration, offset);
            this.result.script.declarations.push(item.id);
            this.bind(item.name, item);
            item.children = [];
            for (const member of declaration.body.body) {
                if (t.isClassMethod(member)) {
                    const name = keyName(member.key, member.computed) ?? `method@${member.loc?.start.line}`;
                    const method = this.add('classMethod', name, member, offset);
                    method.doc = this.docFor(member, offset);
                    item.children.push(method.id);
                    this.addBody({ node: method, body: member.body, params: member.params, optionsMethod: false, fn: member }, offset);
                }
            }
        } else if (t.isVariableDeclaration(declaration)) {
            for (const variable of declaration.declarations) {
                const name = t.isIdentifier(variable.id) ? variable.id.name : `binding@${variable.loc?.start.line}`;
                if (this.variableMacro(variable, name, declaration, offset)) { continue; }
                const part = variable.init && functionPart(variable.init);
                const item = this.add(part ? 'function' : 'variable', name, variable, offset);
                item.doc = this.docFor(variable, offset) ?? this.docFor(declaration, offset);
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

    /** 变量声明直接来自组合式 API 工厂时，登记为 prop / state / computed。 */
    private variableMacro(
        variable: t.VariableDeclarator, name: string, declaration: t.VariableDeclaration, offset: number
    ): boolean {
        const init = variable.init;
        if (!init || !t.isCallExpression(init) || !t.isIdentifier(init.callee)) { return false; }
        const macro = init.callee.name;
        if (macro === 'defineProps') { this.readDefineProps(init, offset); return true; }
        if (macro === 'withDefaults') { this.readWithDefaults(init, offset); return true; }
        if (macro === 'defineEmits') {
            this.readDefineEmits(init, offset);
            if (t.isIdentifier(variable.id)) { this.emitAliases.add(variable.id.name); }
            return true;
        }
        if (macro === 'defineModel') { this.readDefineModel(init, offset, name); return true; }
        // `const store = inject('store')` 仍按普通变量登记，只是额外记录注入键。
        if (macro === 'provide' || macro === 'inject') {
            this.readInjectionCall(init, offset, macro);
            return false;
        }
        const doc = this.docFor(variable, offset) ?? this.docFor(declaration, offset);
        if (macro === 'computed') {
            const item = this.add('computed', name, variable, offset);
            item.doc = doc;
            this.result.script.computed.push(item.id);
            this.result.script.declarations.push(item.id);
            this.bind(name, item);
            this.observe(name, item);
            this.flow(item.id, name);
            return true;
        }
        if (stateFactories.has(macro)) {
            const item = this.add('state', name, variable, offset);
            item.doc = doc;
            this.result.script.data.push(item.id);
            this.result.script.declarations.push(item.id);
            this.states.set(name, [...(this.states.get(name) ?? []), item]);
            this.observe(name, item);
            this.flow(item.id, name);
            return true;
        }
        return false;
    }

    private readWithDefaults(call: t.CallExpression, offset: number): void {
        const [inner, defaults] = call.arguments;
        const fallback = defaults && t.isObjectExpression(defaults) ? defaults : undefined;
        if (inner && t.isCallExpression(inner) && t.isIdentifier(inner.callee, { name: 'defineProps' })) {
            this.readDefineProps(inner, offset, fallback);
        }
    }

    private readDefineProps(
        call: t.CallExpression, offset: number, defaults?: t.ObjectExpression
    ): void {
        const [first] = call.arguments;
        if (first && t.isObjectExpression(first)) {
            this.readPropsObject(first, offset, 'object', defaults);
            return;
        }
        const annotation = this.typeParameter(call);
        if (annotation) {
            const resolved = this.resolveType(annotation);
            if (t.isTSTypeLiteral(resolved) || t.isTSInterfaceBody(resolved)) {
                this.readPropsType(resolved, offset, defaults);
            }
        }
    }

    /** `props: {...}` 与 `defineProps({...})` 的对象写法。 */
    private readPropsObject(
        object: t.ObjectExpression, offset: number, source: 'object', defaults?: t.ObjectExpression
    ): void {
        for (const property of object.properties) {
            if (!t.isObjectProperty(property) && !t.isObjectMethod(property)) { continue; }
            const name = propertyName(property);
            if (!name) { continue; }
            const item = this.add('prop', name, property, offset);
            item.doc = this.docFor(property, offset);
            this.result.script.props.push(item.id);
            const detail = this.propDetail(property, offset);
            const fallback = defaults ? this.defaultFor(defaults, name, offset) : null;
            this.addProp(item, { ...detail, defaultText: detail.defaultText ?? fallback, source });
        }
    }

    /** `defineProps<Props>()` 与 `defineProps<{...}>()` 的类型写法。 */
    private readPropsType(
        typeNode: t.TSTypeLiteral | t.TSInterfaceBody, offset: number, defaults?: t.ObjectExpression
    ): void {
        const members = t.isTSTypeLiteral(typeNode) ? typeNode.members : typeNode.body;
        for (const member of members) {
            if (!t.isTSPropertySignature(member)) { continue; }
            const name = keyName(member.key);
            if (!name) { continue; }
            const item = this.add('prop', name, member, offset);
            item.doc = this.docFor(member, offset);
            this.result.script.props.push(item.id);
            const type = member.typeAnnotation
                ? this.sourceSlice(member.typeAnnotation.typeAnnotation, offset) : null;
            const defaultText = defaults ? this.defaultFor(defaults, name, offset) : null;
            this.addProp(item, {
                type, required: !member.optional, defaultText, hasValidator: false, source: 'type'
            });
        }
    }

    private propDetail(
        property: t.ObjectProperty | t.ObjectMethod, offset: number
    ): Omit<PropContract, 'id' | 'name' | 'source'> {
        const value = t.isObjectProperty(property) ? property.value : undefined;
        if (!value || !t.isObjectExpression(value)) {
            return { type: this.typeText(value, offset), required: false, defaultText: null, hasValidator: false };
        }
        let type: string | null = null;
        let required = false;
        let defaultText: string | null = null;
        let hasValidator = false;
        for (const member of value.properties) {
            if (!t.isObjectProperty(member)) { continue; }
            const key = keyName(member.key);
            if (key === 'type') { type = this.typeText(member.value, offset); }
            else if (key === 'required') { required = t.isBooleanLiteral(member.value) && member.value.value === true; }
            else if (key === 'default') { defaultText = this.sourceSlice(member.value, offset); }
            else if (key === 'validator') { hasValidator = true; }
        }
        return { type, required, defaultText, hasValidator };
    }

    private defaultFor(defaults: t.ObjectExpression, name: string, offset: number): string | null {
        for (const property of defaults.properties) {
            if (t.isObjectProperty(property) && propertyName(property) === name) {
                return this.sourceSlice(property.value, offset);
            }
        }
        return null;
    }

    private addEmit(name: string, line: number): void {
        if (!this.declaredEmits.has(name)) { this.declaredEmits.set(name, line); }
    }

    private readDefineEmits(call: t.CallExpression, offset: number): void {
        const [first] = call.arguments;
        if (first && t.isArrayExpression(first)) {
            for (const element of first.elements) {
                if (element && t.isStringLiteral(element)) { this.addEmit(element.value, this.lineAt(offset, element)); }
            }
            return;
        }
        if (first && t.isObjectExpression(first)) {
            for (const property of first.properties) {
                if (!t.isObjectProperty(property) && !t.isObjectMethod(property)) { continue; }
                const name = propertyName(property);
                if (name) { this.addEmit(name, this.lineAt(offset, property)); }
            }
            return;
        }
        const annotation = this.typeParameter(call);
        if (!annotation) { return; }
        const resolved = this.resolveType(annotation);
        if (!t.isTSTypeLiteral(resolved) && !t.isTSInterfaceBody(resolved)) { return; }
        const members = t.isTSTypeLiteral(resolved) ? resolved.members : resolved.body;
        for (const member of members) {
            if (!t.isTSCallSignatureDeclaration(member)) { continue; }
            const param = member.parameters[0];
            const annotationNode = param ? (param as { typeAnnotation?: t.TSTypeAnnotation | null }).typeAnnotation : undefined;
            if (!annotationNode || !t.isTSTypeAnnotation(annotationNode)) { continue; }
            const literal = annotationNode.typeAnnotation;
            if (t.isTSLiteralType(literal) && t.isStringLiteral(literal.literal)) {
                this.addEmit(literal.literal.value, this.lineAt(offset, member));
            }
        }
    }

    private readDefineModel(call: t.CallExpression, offset: number, alias?: string): void {
        const [first] = call.arguments;
        const name = first && t.isStringLiteral(first) ? first.value : 'modelValue';
        const item = this.add('prop', name, call, offset);
        this.result.script.props.push(item.id);
        const type = this.typeText(this.typeParameter(call), offset);
        this.addProp(item, { type, required: false, defaultText: null, hasValidator: false, source: 'type' });
        this.addEmit(`update:${name}`, this.lineAt(offset, call));
        if (alias && alias !== name) { this.observe(alias, item); }
    }

    private readInjectionCall(call: t.CallExpression, offset: number, kind: 'provide' | 'inject'): void {
        const [first] = call.arguments;
        const line = this.lineAt(offset, call);
        if (first && t.isStringLiteral(first)) {
            this.result.contract.injections.push({ key: first.value, kind, line, certainty: 'certain' });
        } else {
            this.result.contract.injections.push({
                key: first ? this.sourceSlice(first, offset) : '未知', kind, line,
                certainty: 'unresolved', reason: '键不是静态字符串，无法离线确认'
            });
        }
    }

    private readWatchCall(call: t.CallExpression, offset: number): void {
        const [source] = call.arguments;
        let watched: string | undefined;
        let target: t.Identifier | undefined;
        if (source && t.isIdentifier(source)) {
            watched = source.name;
            target = source;
        } else if (source && t.isArrowFunctionExpression(source)) {
            const [found] = readIdentifiers(source.body);
            watched = found?.name;
            target = found;
        }
        const item = this.add('watch', watched ?? 'watch', call, offset);
        item.doc = this.docFor(call, offset);
        this.result.script.watch.push(item.id);
        for (const node of this.observables.get(watched ?? '') ?? []) {
            const flow = this.flow(node.id, node.name);
            const line = target ? this.lineAt(offset, target) : this.lineAt(offset, call);
            if (!flow.watches.some(watch => watch.id === item.id)) {
                flow.watches.push({ id: item.id, line });
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
            method.doc = this.docFor(property, offset);
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
                    this.readPropsObject(property.value, offset, 'object');
                } else if (t.isArrayExpression(property.value)) {
                    for (const value of property.value.elements) {
                        if (value && t.isStringLiteral(value)) {
                            const item = this.add('prop', value.value, value, offset);
                            this.result.script.props.push(item.id);
                            this.addProp(item, {
                                type: null, required: false, defaultText: null, hasValidator: false, source: 'array'
                            });
                        }
                    }
                }
            } else if (name === 'emits' && t.isObjectProperty(property)) {
                if (t.isArrayExpression(property.value)) {
                    for (const value of property.value.elements) {
                        if (value && t.isStringLiteral(value)) {
                            this.addEmit(value.value, this.lineAt(offset, value));
                        }
                    }
                } else if (t.isObjectExpression(property.value)) {
                    for (const member of property.value.properties) {
                        if (!t.isObjectProperty(member) && !t.isObjectMethod(member)) { continue; }
                        const emitName = propertyName(member);
                        if (emitName) { this.addEmit(emitName, this.lineAt(offset, member)); }
                    }
                }
            } else if (name === 'model' && t.isObjectProperty(property) && t.isObjectExpression(property.value)) {
                for (const member of property.value.properties) {
                    if (!t.isObjectProperty(member)) { continue; }
                    const key = keyName(member.key);
                    if ((key === 'prop' || key === 'event') && t.isStringLiteral(member.value)) {
                        if (key === 'event') { this.addEmit(member.value.value, this.lineAt(offset, member)); }
                    }
                }
            } else if (name === 'provide' || name === 'inject') {
                this.readInjectionOption(property, offset, name);
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
                    item.doc = this.docFor(member, offset);
                    section.push(item.id);
                    if (name === 'methods' && part) {
                        this.bind(memberName, item, true);
                    }
                    if (name === 'computed') {
                        this.observe(memberName, item);
                        this.flow(item.id, memberName);
                    }
                    if (name === 'watch') {
                        for (const node of this.observables.get(memberName) ?? []) {
                            const flow = this.flow(node.id, node.name);
                            flow.watches.push({ id: item.id, line: item.range.startLine });
                        }
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
                    item.doc = this.docFor(property, offset);
                    this.result.script.hooks.push(item.id);
                    this.addBody({ node: item, ...part, optionsMethod: true }, offset);
                }
            }
        }
    }

    /** Options API 的 `provide` / `inject` 选项。 */
    private readInjectionOption(
        property: t.ObjectMethod | t.ObjectProperty, offset: number, kind: 'provide' | 'inject'
    ): void {
        const line = this.lineAt(offset, property);
        if (t.isObjectProperty(property) && t.isArrayExpression(property.value)) {
            for (const value of property.value.elements) {
                if (value && t.isStringLiteral(value)) {
                    this.result.contract.injections.push({
                        key: value.value, kind, line: this.lineAt(offset, value), certainty: 'certain'
                    });
                }
            }
            return;
        }
        if (t.isObjectProperty(property) && t.isObjectExpression(property.value)) {
            for (const member of property.value.properties) {
                if (!t.isObjectProperty(member) && !t.isObjectMethod(member)) { continue; }
                const key = propertyName(member);
                if (key) {
                    this.result.contract.injections.push({
                        key, kind, line: this.lineAt(offset, member), certainty: 'certain'
                    });
                }
            }
            return;
        }
        const part = functionPart(property);
        if (kind === 'provide' && part && t.isBlockStatement(part.body)) {
            for (const statement of part.body.body) {
                if (t.isReturnStatement(statement) && statement.argument && t.isObjectExpression(statement.argument)) {
                    for (const member of statement.argument.properties) {
                        if (!t.isObjectProperty(member) && !t.isObjectMethod(member)) { continue; }
                        const key = propertyName(member);
                        if (key) {
                            this.result.contract.injections.push({
                                key, kind, line: this.lineAt(offset, member), certainty: 'certain'
                            });
                        }
                    }
                }
            }
        } else if (kind === 'provide' && part && t.isObjectExpression(part.body)) {
            for (const member of part.body.properties) {
                if (!t.isObjectProperty(member) && !t.isObjectMethod(member)) { continue; }
                const key = propertyName(member);
                if (key) {
                    this.result.contract.injections.push({
                        key, kind, line: this.lineAt(offset, member), certainty: 'certain'
                    });
                }
            }
        } else if (t.isObjectMethod(property)) {
            this.result.contract.injections.push({
                key: line ? `(L${line})` : '未知', kind, line,
                certainty: 'unresolved', reason: '无法从源码确认静态键'
            });
        }
    }

    private readFields(
        object: t.ObjectExpression, offset: number, kind: 'state', output: string[]
    ): void {
        for (const property of object.properties) {
            if (!t.isObjectProperty(property) && !t.isObjectMethod(property)) {
                continue;
            }
            const name = propertyName(property);
            if (name) {
                const item = this.add(kind, name, property, offset);
                item.doc = this.docFor(property, offset);
                output.push(item.id);
                this.states.set(name, [...(this.states.get(name) ?? []), item]);
                this.observe(name, item);
                this.flow(item.id, name);
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
        this.scanReads(body, localNames);
        visit(body.body, node => {
            if (t.isCallExpression(node) || t.isOptionalCallExpression(node)) {
                this.scanCall(body, node, localNames);
            } else if (t.isAssignmentExpression(node) || t.isUpdateExpression(node)) {
                this.scanWrite(body, node);
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

    private scanReads(body: FunctionBody, localNames: Set<string>): void {
        const offset = this.offsetFor(body.node);
        const recorded = new Set<string>();
        for (const identifier of readIdentifiers(body.body)) {
            if (localNames.has(identifier.name)) { continue; }
            const matches = this.observables.get(identifier.name) ?? [];
            if (!matches.length || recorded.has(identifier.name)) { continue; }
            recorded.add(identifier.name);
            const line = this.lineAt(offset, identifier);
            for (const target of matches) {
                const flow = this.flow(target.id, target.name);
                if (!flow.reads.some(read => read.id === body.node.id)) {
                    flow.reads.push({ id: body.node.id, line });
                }
            }
        }
    }

    private scanCall(
        body: FunctionBody, node: t.CallExpression | t.OptionalCallExpression, localNames: Set<string>
    ): void {
        const callee = node.callee;
        if (t.isIdentifier(callee) && this.emitAliases.has(callee.name)) {
            this.scanEmitTrigger(body, node, node.arguments[0]);
            return;
        }
        let name: string | undefined;
        let matches: NavNode[] = [];
        if (t.isIdentifier(callee)) {
            name = callee.name;
            matches = localNames.has(name) ? [] : this.bindings.get(name) ?? [];
        } else if (t.isMemberExpression(callee) && !callee.computed
            && t.isThisExpression(callee.object) && t.isIdentifier(callee.property)) {
            name = callee.property.name;
            if (name === '$emit') {
                this.scanEmitTrigger(body, node, node.arguments[0]);
                return;
            }
            matches = body.optionsMethod ? this.methods.get(name) ?? [] : [];
        }
        const offset = this.offsetFor(body.node);
        const target = !node.optional && matches.length === 1
            && (matches[0].kind === 'function' || matches[0].kind === 'method')
            ? matches[0] : undefined;
        this.result.paths.push({
            from: body.node.id, to: target?.id, targetName: name,
            type: 'calls', certainty: target ? 'certain' : 'unresolved',
            evidence: this.sourceMap.range((node.start ?? 0) + offset, (node.end ?? 0) + offset),
            reason: target ? undefined : '动态调用、外部依赖或无法唯一解析'
        });
    }

    /** `this.$emit('x')` 与 `<script setup>` 里的 `emit('x')` 触发点。 */
    private scanEmitTrigger(
        body: FunctionBody, node: t.CallExpression | t.OptionalCallExpression, first?: t.Node | null
    ): void {
        if (!first || !t.isStringLiteral(first)) { return; }
        const offset = this.offsetFor(body.node);
        const line = this.sourceMap.position(offset + (node.start ?? 0)).line;
        const list = this.emitTriggers.get(first.value) ?? [];
        list.push({ line, ownerId: body.node.id, ownerName: body.node.name });
        this.emitTriggers.set(first.value, list);
    }

    private scanWrite(body: FunctionBody, node: t.AssignmentExpression | t.UpdateExpression): void {
        const left = t.isAssignmentExpression(node) ? node.left : node.argument;
        let name: string | undefined;
        let evidence: t.Node = left;
        if (t.isMemberExpression(left) && !left.computed && t.isThisExpression(left.object)
            && t.isIdentifier(left.property)) {
            name = left.property.name;
        } else if (t.isMemberExpression(left) && !left.computed
            && t.isIdentifier(left.object) && t.isIdentifier(left.property, { name: 'value' })) {
            name = left.object.name;
            evidence = left.object;
        } else if (t.isIdentifier(left)) {
            name = left.name;
        }
        if (!name) { return; }
        const matches = this.states.get(name) ?? this.observables.get(name) ?? [];
        const offset = this.offsetFor(body.node);
        const line = this.sourceMap.position(offset + (evidence.start ?? 0)).line;
        for (const target of matches) {
            const flow = this.flow(target.id, target.name);
            if (!flow.writes.some(write => write.id === body.node.id)) {
                flow.writes.push({ id: body.node.id, line });
            }
        }
        const target = body.optionsMethod && matches.length === 1 ? matches[0] : undefined;
        this.result.paths.push({
            from: body.node.id, to: target?.id, targetName: name,
            type: 'writes', certainty: target ? 'certain' : 'unresolved',
            evidence: this.sourceMap.range((left.start ?? 0) + offset, (left.end ?? 0) + offset),
            reason: target ? undefined : '未找到唯一的本文件状态声明'
        });
    }

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

    /** 汇总 emits 声明与触发点，输出契约与状态数据流。 */
    private finalizeContract(): void {
        const names = new Set([...this.declaredEmits.keys(), ...this.emitTriggers.keys()]);
        const emits = [...names].map(name => ({
            name,
            declared: this.declaredEmits.has(name),
            declarationLine: this.declaredEmits.get(name) ?? null,
            triggers: (this.emitTriggers.get(name) ?? []).slice()
        }));
        emits.sort((left, right) =>
            (left.declarationLine ?? left.triggers[0]?.line ?? 0) - (right.declarationLine ?? right.triggers[0]?.line ?? 0));
        this.result.contract.emits = emits;
        for (const flow of this.flows.values()) {
            flow.reads.sort((left, right) => left.line - right.line);
            flow.writes.sort((left, right) => left.line - right.line);
            flow.watches.sort((left, right) => left.line - right.line);
            flow.templateLines.sort((left, right) => left - right);
        }
        this.result.contract.flows = [...this.flows.values()];
    }

    /** 顺序时间轴与函数卡片：全部来自本文件静态语法，不做运行时推断。 */
    private finalizeStructure(): void {
        this.buildTimeline();
        this.buildFunctions();
    }

    /** 初始化与生命周期步骤，按源码出现位置推定顺序。 */
    private buildTimeline(): void {
        const steps: TimelineStep[] = [];
        for (const node of this.result.nodes) {
            if (node.kind === 'state' || node.kind === 'computed'
                || node.kind === 'watch' || node.kind === 'hook') {
                steps.push({ name: node.name, kind: node.kind, id: node.id, line: node.range.startLine });
            }
        }
        steps.sort((left, right) => left.line - right.line);
        this.result.timeline = steps;
    }

    private hasReturn(body: t.Node): boolean {
        if (!t.isBlockStatement(body)) { return true; }
        let found = false;
        visit(body, node => {
            if (t.isReturnStatement(node) && node.argument) { found = true; }
        });
        return found;
    }

    private hasErrorHandling(body: t.Node): boolean {
        let found = false;
        visit(body, node => {
            if (t.isTryStatement(node)) { found = true; }
        });
        return found;
    }

    /** 每个函数 / 方法的签名、语义标记与影响面（调用方、内部调用、写入的状态）。 */
    private buildFunctions(): void {
        const byId = new Map<string, NavNode>(this.result.nodes.map(node => [node.id, node]));
        const calls = this.result.paths.filter(edge =>
            edge.type === 'calls' && edge.certainty === 'certain' && edge.to);
        const writes = this.result.paths.filter(edge =>
            edge.type === 'writes' && edge.certainty === 'certain' && edge.to);
        const cards: FunctionCard[] = [];
        for (const body of this.bodies) {
            const node = body.node;
            const offset = this.offsetFor(node);
            const fn = body.fn;
            const isAsync = Boolean(fn && t.isFunction(fn) && fn.async);
            const params = body.params.map(parameter => this.sourceSlice(parameter, offset));
            const callers: FunctionRef[] = [];
            const callees: FunctionRef[] = [];
            const wrote: FunctionRef[] = [];
            const seen = new Set<string>();
            for (const edge of calls) {
                if (edge.to === node.id) {
                    const source = byId.get(edge.from);
                    if (source) {
                        callers.push({ id: source.id, name: source.name, line: edge.evidence.startLine });
                    }
                }
                if (edge.from === node.id && edge.to) {
                    const target = byId.get(edge.to);
                    if (target) {
                        callees.push({ id: target.id, name: target.name, line: edge.evidence.startLine });
                    }
                }
            }
            for (const edge of writes) {
                if (edge.from !== node.id || !edge.to || seen.has(edge.to)) { continue; }
                const target = byId.get(edge.to);
                if (target) {
                    seen.add(edge.to);
                    wrote.push({ id: target.id, name: target.name, line: edge.evidence.startLine });
                }
            }
            cards.push({
                id: node.id,
                name: node.name,
                signature: `${isAsync ? 'async ' : ''}${node.name}(${params.join(', ')})`,
                line: node.range.startLine,
                isAsync,
                hasReturn: this.hasReturn(body.body),
                errorHandling: this.hasErrorHandling(body.body),
                params,
                callers,
                callees,
                writes: wrote
            });
        }
        this.result.functions = cards;
    }
}
