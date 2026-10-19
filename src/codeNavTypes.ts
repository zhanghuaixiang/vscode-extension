export type NodeKind =
    | 'template' | 'component' | 'event' | 'script' | 'import' | 'export'
    | 'function' | 'method' | 'class' | 'classMethod' | 'variable'
    | 'prop' | 'state' | 'computed' | 'watch' | 'hook' | 'return' | 'comment';

export interface SourceRange {
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
}

/** 作者写在节点上方的原文，不做翻译和概括。 */
export interface DocComment {
    text: string;
    line: number;
    tags: { tag: string; text: string }[];
}

/** 源码里的 TODO / FIXME / HACK / 模板备注，正文按原样保留。 */
export interface CommentNote {
    id: string;
    kind: 'todo' | 'fixme' | 'hack' | 'note';
    text: string;
    line: number;
    block: 'template' | 'script';
}

/** 组件对外契约：单个 prop 的声明细节，类型与默认值按源码原样保留。 */
export interface PropContract {
    id: string;
    name: string;
    type: string | null;
    required: boolean;
    defaultText: string | null;
    hasValidator: boolean;
    source: 'object' | 'array' | 'type';
}

/** 一次 `$emit` / `emit` 触发点。 */
export interface EmitTrigger {
    line: number;
    ownerId: string;
    ownerName: string;
}

/** 组件对外事件：是否在 emits 中声明，以及本文件内的触发点。 */
export interface EmitContract {
    name: string;
    declared: boolean;
    declarationLine: number | null;
    triggers: EmitTrigger[];
}

/** 本文件模板里声明的插槽。 */
export interface SlotContract {
    name: string;
    id: string;
    line: number;
    scoped: boolean;
}

/** provide / inject 的键。 */
export interface InjectionEntry {
    key: string;
    kind: 'provide' | 'inject';
    line: number;
    certainty: 'certain' | 'unresolved';
    reason?: string;
}

export interface FlowRef {
    id: string;
    line: number;
}

/** 单个状态 / prop / computed 在本文件内的读写、watch 与模板引用。 */
export interface StateFlow {
    id: string;
    name: string;
    reads: FlowRef[];
    writes: FlowRef[];
    watches: FlowRef[];
    templateLines: number[];
}

/** 初始化与生命周期的一步；顺序按源码顺序或 Vue 约定推定。 */
export interface TimelineStep {
    name: string;
    kind: 'state' | 'computed' | 'watch' | 'hook';
    id: string | null;
    line: number;
}

/** 带名称的节点引用，便于面板直接展示而不依赖是否被裁剪保留。 */
export interface FunctionRef {
    id: string;
    name: string;
    line: number;
}

/** 函数卡片：签名、语义标记与本文件内的影响面，全部来自静态语法。 */
export interface FunctionCard {
    id: string;
    name: string;
    signature: string;
    line: number;
    isAsync: boolean;
    hasReturn: boolean;
    errorHandling: boolean;
    params: string[];
    callers: FunctionRef[];
    callees: FunctionRef[];
    writes: FunctionRef[];
}

export interface NavNode {
    id: string;
    name: string;
    kind: NodeKind;
    range: SourceRange;
    children?: string[];
    doc?: DocComment;
}

export interface TemplateNode {
    id: string;
    tag: string;
    isComponent: boolean;
    range: SourceRange;
    attrs: string[];
    listeners: string[];
    children: TemplateNode[];
}

export interface CodeRelation {
    from: string;
    to?: string;
    targetName?: string;
    type: 'event-handler' | 'calls' | 'writes' | 'exports' | 'returns';
    certainty: 'certain' | 'unresolved';
    evidence: SourceRange;
    reason?: string;
}

export interface CodeDiagnostic {
    message: string;
    line?: number;
    block?: 'template' | 'script' | 'file';
}

export interface CodeNavResult {
    version: 1;
    file: string;
    fileType: 'vue' | 'js' | 'ts';
    meta: {
        totalLines: number;
        componentName: string | null;
        sizeRank: 'small' | 'medium' | 'large' | 'huge';
    };
    nodes: NavNode[];
    template: { rootEl: string | null; tree: TemplateNode[] } | null;
    script: {
        name: string | null;
        declarations: string[];
        exports: string[];
        props: string[];
        data: string[];
        computed: string[];
        watch: string[];
        hooks: string[];
        groups: { label: string; rule: string; methods: string[] }[];
    };
    imports: string[];
    doc: DocComment | null;
    comments: CommentNote[];
    contract: {
        props: PropContract[];
        emits: EmitContract[];
        slots: SlotContract[];
        injections: InjectionEntry[];
        flows: StateFlow[];
    };
    timeline: TimelineStep[];
    functions: FunctionCard[];
    guide: {
        summary: {
            text: string;
            origin: 'comment' | 'structure';
            confidence: 'fact';
            evidence: number[];
        } | null;
        entries: string[];
        state: string[];
    };
    paths: CodeRelation[];
    errors: CodeDiagnostic[];
}

export class SourceMap {
    private readonly starts = [0];

    constructor(private readonly source: string) {
        for (let i = 0; i < source.length; i++) {
            if (source[i] === '\n') {
                this.starts.push(i + 1);
            }
        }
    }

    get totalLines(): number {
        return this.starts.length;
    }

    range(start: number, end: number): SourceRange {
        const from = this.position(start);
        const to = this.position(end);
        return {
            startLine: from.line, startColumn: from.column,
            endLine: to.line, endColumn: to.column
        };
    }

    position(offset: number): { line: number; column: number } {
        const safe = Math.max(0, Math.min(offset, this.source.length));
        let low = 0;
        let high = this.starts.length;
        while (low + 1 < high) {
            const middle = (low + high) >> 1;
            if (this.starts[middle] <= safe) {
                low = middle;
            } else {
                high = middle;
            }
        }
        return { line: low + 1, column: safe - this.starts[low] + 1 };
    }
}

export function makeNode(
    kind: NodeKind, name: string, start: number, end: number, sourceMap: SourceMap
): NavNode {
    return {
        id: `${kind}:${start}:${end}:${name}`,
        name,
        kind,
        range: sourceMap.range(start, end)
    };
}
