import { CodeNavResult, CodeRelation, NavNode, TemplateNode } from './codeNavTypes';

export const PAGE_SIZE = 50;

export interface PanelResult extends Omit<CodeNavResult, 'nodes' | 'paths' | 'template'> {
    nodes: NavNode[];
    paths: (CodeRelation & { index: number })[];
    template: { rootEl: string | null; tree: (TemplateNode & { hasChildren?: boolean })[] } | null;
    pagination: {
        sections: Record<string, number>;
        templateCount: number;
        entryCount: number;
        errorCount: number;
        commentCount: number;
        propCount: number;
        emitCount: number;
        slotCount: number;
        injectionCount: number;
        flowCount: number;
        timelineCount: number;
        functionCount: number;
    };
}

const scriptKeys = [
    'exports', 'declarations', 'props', 'data', 'computed', 'watch', 'hooks'
] as const;
const nodeIndexes = new WeakMap<CodeNavResult, Map<string, NavNode>>();

function nodeIndex(result: CodeNavResult): Map<string, NavNode> {
    let index = nodeIndexes.get(result);
    if (!index) {
        index = new Map(result.nodes.map(node => [node.id, node]));
        nodeIndexes.set(result, index);
    }
    return index;
}

export function sectionIds(result: CodeNavResult, key: string): string[] | undefined {
    if (key === 'imports') { return result.imports; }
    if (key.startsWith('group:')) {
        const index = Number(key.slice(6));
        if (!Number.isInteger(index) || index < 0) { return undefined; }
        return result.script.groups[index]?.methods;
    }
    if (scriptKeys.some(item => item === key)) {
        return result.script[key as typeof scriptKeys[number]];
    }
    return undefined;
}

export function sectionPage(result: CodeNavResult, key: string, offset: number): NavNode[] | undefined {
    const ids = sectionIds(result, key);
    if (!ids || !Number.isInteger(offset) || offset < 0 || offset >= Math.max(ids.length, 1)) {
        return undefined;
    }
    const nodes = nodeIndex(result);
    return ids.slice(offset, offset + PAGE_SIZE)
        .map(id => nodes.get(id))
        .filter((node): node is NavNode => node !== undefined);
}

function shallowTemplate(node: TemplateNode): TemplateNode & { hasChildren: boolean } {
    return { ...node, hasChildren: node.children.length > 0, children: [] };
}

/** 面板检索的一行命中。 */
export interface NodeMatch {
    id: string;
    name: string;
    kind: string;
    line: number;
}

/**
 * 面板内按名字检索：完全同名 → 前缀 → 包含，同级按行号升序，结果截断到 limit。
 * 纯函数，只扫内存里已有的节点，不读磁盘、不建索引。
 */
export function matchNodes(
    nodes: NavNode[], text: string, limit: number
): { total: number; matches: NodeMatch[] } {
    const needle = text.trim().toLowerCase();
    if (needle.length < 2) { return { total: 0, matches: [] }; }
    const scored: { match: NodeMatch; score: number }[] = [];
    for (const node of nodes) {
        if (!node.name) { continue; }
        const lower = node.name.toLowerCase();
        const score = lower === needle ? 0 : lower.startsWith(needle) ? 1 : lower.includes(needle) ? 2 : -1;
        if (score < 0) { continue; }
        scored.push({
            match: { id: node.id, name: node.name, kind: node.kind, line: node.range.startLine },
            score
        });
    }
    scored.sort((left, right) => (left.score - right.score) || (left.match.line - right.match.line));
    return {
        total: scored.length,
        matches: scored.slice(0, Math.max(0, limit)).map(item => item.match)
    };
}

export function templatePage(
    result: CodeNavResult, parentId: string | null, offset: number
): { items: (TemplateNode & { hasChildren: boolean })[]; total: number } | undefined {
    if (!result.template || !Number.isInteger(offset) || offset < 0) { return undefined; }
    let children = result.template.tree;
    if (parentId !== null) {
        const stack = [...children];
        let found: TemplateNode | undefined;
        while (stack.length) {
            const next = stack.pop()!;
            if (next.id === parentId) {
                found = next;
                break;
            }
            stack.push(...next.children);
        }
        if (!found) { return undefined; }
        children = found.children;
    }
    return {
        total: children.length,
        items: children.slice(offset, offset + PAGE_SIZE).map(shallowTemplate)
    };
}

export function projectResult(result: CodeNavResult, focusId?: string): PanelResult {
    const sections: Record<string, number> = { imports: result.imports.length };
    for (const key of scriptKeys) { sections[key] = result.script[key].length; }
    for (const [index, group] of result.script.groups.entries()) {
        sections[`group:${index}`] = group.methods.length;
    }
    const guideEntries = result.guide.entries.slice(0, 8);
    const selected = new Set([
        ...guideEntries,
        ...result.guide.state.slice(0, 12),
        ...(focusId ? [focusId] : [])
    ]);
    const paths: PanelResult['paths'] = [];
    // 同一条关系可能被「聚焦入边」与「深度扩散」同时命中，按原始下标去重，避免重复行重复占用配额。
    const included = new Set<number>();
    const include = (index: number): boolean => {
        if (included.has(index)) { return false; }
        included.add(index);
        paths.push({ ...result.paths[index], index });
        return true;
    };
    if (focusId) {
        for (const [index, edge] of result.paths.entries()) {
            if (edge.to !== focusId || paths.length >= 30) { continue; }
            if (include(index)) { selected.add(edge.from); }
        }
    }
    let frontier = new Set(selected);
    for (let depth = 0; depth < 3 && frontier.size && paths.length < 120; depth++) {
        const next = new Set<string>();
        for (const [index, edge] of result.paths.entries()) {
            if (!frontier.has(edge.from) || paths.length >= 120) { continue; }
            if (!include(index)) { continue; }
            if (edge.to) {
                selected.add(edge.to);
                next.add(edge.to);
            }
        }
        frontier = next;
    }
    const script = { ...result.script };
    for (const key of scriptKeys) {
        const page = result.script[key].slice(0, PAGE_SIZE);
        script[key] = page;
        page.forEach(id => selected.add(id));
    }
    script.groups = result.script.groups.map(group => {
        const methods = group.methods.slice(0, PAGE_SIZE);
        methods.forEach(id => selected.add(id));
        return { ...group, methods };
    });
    const imports = result.imports.slice(0, PAGE_SIZE);
    imports.forEach(id => selected.add(id));
    const template = result.template && {
        rootEl: result.template.rootEl,
        tree: result.template.tree.slice(0, PAGE_SIZE).map(shallowTemplate)
    };
    template?.tree.forEach(node => selected.add(node.id));
    for (const prop of result.contract.props) { selected.add(prop.id); }
    for (const slot of result.contract.slots) { selected.add(slot.id); }
    for (const emit of result.contract.emits) {
        for (const trigger of emit.triggers) { selected.add(trigger.ownerId); }
    }
    for (const flow of result.contract.flows) {
        selected.add(flow.id);
        for (const ref of [...flow.reads, ...flow.writes, ...flow.watches]) { selected.add(ref.id); }
    }
    const timeline = result.timeline.slice(0, 60);
    for (const step of timeline) {
        if (step.id) { selected.add(step.id); }
    }
    const functions = result.functions.slice(0, 60);
    const nodes = result.nodes.filter(node => selected.has(node.id));
    for (const node of nodes) {
        node.children?.slice(0, PAGE_SIZE).forEach(id => selected.add(id));
    }
    return {
        ...result,
        nodes: result.nodes.filter(node => selected.has(node.id)),
        paths,
        imports,
        script,
        template,
        timeline,
        functions,
        guide: { ...result.guide, entries: guideEntries, state: result.guide.state.slice(0, 12) },
        errors: result.errors.slice(0, 20),
        comments: result.comments.slice(0, 40),
        pagination: {
            sections,
            templateCount: result.template?.tree.length ?? 0,
            entryCount: result.guide.entries.length,
            errorCount: result.errors.length,
            commentCount: result.comments.length,
            propCount: result.contract.props.length,
            emitCount: result.contract.emits.length,
            slotCount: result.contract.slots.length,
            injectionCount: result.contract.injections.length,
            flowCount: result.contract.flows.length,
            timelineCount: result.timeline.length,
            functionCount: result.functions.length
        }
    };
}
