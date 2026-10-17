import { parse as parseVue } from '@vue/compiler-sfc';
import type { ElementNode, TemplateChildNode } from '@vue/compiler-core';
import { ScriptAnalyzer, ScriptBlock } from './codeNavScript';
import { CodeNavResult, makeNode, SourceMap, TemplateNode } from './codeNavTypes';

function templateTree(
    children: TemplateChildNode[], result: CodeNavResult, sourceMap: SourceMap,
    scripts: ScriptAnalyzer, hasLocalScope = false
): TemplateNode[] {
    const tree: TemplateNode[] = [];
    for (const child of children) {
        // Vue compiler-core: NodeTypes.ELEMENT = 1.
        if (child.type !== 1) {
            continue;
        }
        const element = child as ElementNode;
        const tag = element.tag;
        const node = makeNode(
            element.tagType === 1 ? 'component' : 'template',
            tag, element.loc.start.offset, element.loc.end.offset, sourceMap
        );
        const entry: TemplateNode = {
            id: node.id,
            tag,
            isComponent: element.tagType === 1 || /^[A-Z]/.test(tag) || tag.includes('-'),
            range: node.range,
            attrs: [],
            listeners: [],
            children: []
        };
        result.nodes.push(node);
        const locallyScoped = hasLocalScope || element.props.some(
            prop => prop.type === 7 && (prop.name === 'for' || prop.name === 'slot')
        );
        for (const prop of element.props) {
            if (prop.type === 6) {
                entry.attrs.push(prop.name);
                continue;
            }
            if (prop.name !== 'on') {
                entry.attrs.push(prop.rawName ?? prop.name);
                continue;
            }
            const event = prop.arg?.type === 4 && prop.arg.isStatic ? prop.arg.content : 'dynamic';
            entry.listeners.push(event);
            const start = prop.loc.start.offset;
            const end = prop.loc.end.offset;
            const trigger = makeNode('event', event, start, end, sourceMap);
            result.nodes.push(trigger);
            result.guide.entries.push(trigger.id);
            const expression = prop.exp?.type === 4 ? prop.exp.content.trim() : '';
            const match = /^(?:this\.)?([A-Za-z_$][\w$]*)(?:\([^()]*\))?$/.exec(expression);
            const target = !locallyScoped && event !== 'dynamic' && match
                ? scripts.resolveHandler(match[1]) : undefined;
            result.paths.push({
                from: trigger.id,
                to: target?.id,
                targetName: match?.[1] ?? (expression || undefined),
                type: 'event-handler',
                certainty: target ? 'certain' : 'unresolved',
                evidence: sourceMap.range(start, end),
                reason: target ? undefined : locallyScoped
                    ? '模板局部作用域可能遮蔽处理函数'
                    : '动态表达式或未找到唯一的本文件处理函数'
            });
        }
        entry.children = templateTree(element.children, result, sourceMap, scripts, locallyScoped);
        tree.push(entry);
    }
    return tree;
}

function sizeRank(lines: number): CodeNavResult['meta']['sizeRank'] {
    if (lines > 10000) { return 'huge'; }
    if (lines > 3000) { return 'large'; }
    if (lines > 500) { return 'medium'; }
    return 'small';
}

export function analyze(source: string, fileName: string): CodeNavResult {
    const fileType = fileName.toLowerCase().endsWith('.vue') ? 'vue' : 'js';
    const sourceMap = new SourceMap(source);
    const result: CodeNavResult = {
        version: 1,
        file: fileName,
        fileType,
        meta: { totalLines: sourceMap.totalLines, componentName: null, sizeRank: sizeRank(sourceMap.totalLines) },
        nodes: [],
        template: null,
        script: {
            name: null, declarations: [], exports: [], props: [], data: [],
            computed: [], watch: [], hooks: [], groups: []
        },
        imports: [],
        guide: { summary: null, entries: [], state: [] },
        paths: [],
        errors: []
    };
    const scripts = new ScriptAnalyzer(result, sourceMap);
    if (fileType === 'js') {
        scripts.analyze([{ content: source, offset: 0, lang: 'js' }]);
    } else {
        try {
            const parsed = parseVue(source, { filename: fileName });
            for (const error of parsed.errors) {
                const location = 'loc' in error ? error.loc : undefined;
                result.errors.push({
                    message: error.message,
                    line: location?.start.line,
                    block: 'template'
                });
            }
            const blocks: ScriptBlock[] = [];
            for (const block of [parsed.descriptor.script, parsed.descriptor.scriptSetup]) {
                if (!block) { continue; }
                if (block.src) {
                    result.errors.push({
                        message: '外部 script src 不在单文件分析范围内',
                        line: block.loc.start.line, block: 'script'
                    });
                    continue;
                }
                blocks.push({ content: block.content, offset: block.loc.start.offset, lang: block.lang });
            }
            scripts.analyze(blocks);
            const template = parsed.descriptor.template;
            if (template) {
                const tree = template.ast
                    ? templateTree(template.ast.children, result, sourceMap, scripts) : [];
                result.template = { rootEl: tree[0]?.tag ?? null, tree };
                if (!template.ast) {
                    result.errors.push({
                        message: '模板未能解析，保留 script 结构',
                        line: template.loc.start.line, block: 'template'
                    });
                }
            }
        } catch (error) {
            result.errors.push({
                message: error instanceof Error ? error.message : String(error),
                block: 'file'
            });
            // A malformed SFC may still have recognizable block boundaries.
            const blocks = /<(template|script)\b[^>]*>/gi;
            for (const match of source.matchAll(blocks)) {
                const tag = match[1].toLowerCase() as 'template' | 'script';
                const start = match.index;
                const closing = source.indexOf(`</${tag}>`, start + match[0].length);
                const end = closing < 0 ? start + match[0].length : closing + tag.length + 3;
                result.nodes.push(makeNode(tag, tag, start, end, sourceMap));
                if (tag === 'template') {
                    result.template = { rootEl: null, tree: [] };
                }
            }
        }
    }

    const entry = result.nodes.find(node => node.id === result.guide.entries[0]);
    const namedComponent = result.nodes.find(node => node.kind === 'component'
        && node.name === result.meta.componentName);
    if (result.meta.componentName) {
        result.guide.summary = {
            text: `组件 ${result.meta.componentName}；本文件可见 ${result.guide.entries.length} 个入口`,
            confidence: 'fact',
            evidence: namedComponent ? [namedComponent.range.startLine] : []
        };
    } else if (result.script.exports.length) {
        result.guide.summary = {
            text: `本文件包含 ${result.script.exports.length} 个可识别导出`,
            confidence: 'fact',
            evidence: entry ? [entry.range.startLine] : []
        };
    }
    return result;
}
