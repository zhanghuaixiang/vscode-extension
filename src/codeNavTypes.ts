export type NodeKind =
    | 'template' | 'component' | 'event' | 'script' | 'import' | 'export'
    | 'function' | 'method' | 'class' | 'classMethod' | 'variable'
    | 'prop' | 'state' | 'computed' | 'watch' | 'hook' | 'return';

export interface SourceRange {
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
}

export interface NavNode {
    id: string;
    name: string;
    kind: NodeKind;
    range: SourceRange;
    children?: string[];
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
    fileType: 'vue' | 'js';
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
    guide: {
        summary: { text: string; confidence: 'fact'; evidence: number[] } | null;
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
