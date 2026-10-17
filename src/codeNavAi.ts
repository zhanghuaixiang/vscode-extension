import * as crypto from 'crypto';
import { CodeNavResult, NavNode } from './codeNavTypes';

/** 修改 prompt 模板或上下文结构时必须递增，用于让已有的 AI 结果缓存失效。 */
export const AI_PROMPT_VERSION = 3;

export const AI_SYSTEM_PROMPT = [
    '你是代码阅读助手，帮助开发者快速抓住一个陌生源文件的重点。',
    '只依据下面给出的静态事实与源码做解释，不要编造调用关系、读写关系或运行时执行顺序。',
    '严格控制篇幅：文件级最多 4 条要点、合计不超过 150 字；节点级最多 3 条、合计不超过 80 字。',
    '不复述代码逐行内容，只给结论：这段代码做什么、关键分支在哪、改动时要注意什么。',
    '每条结论后用 [L12] 或 [L12-L18] 标注依据行号，行号必须来自下面出现过的内容。',
    '用中文输出 markdown：优先用 - 列表、**加粗**与 `行内代码`；不要标题、表格，不要粘贴大段代码块。'
].join('\n');

export type AiScope = { kind: 'file' } | { kind: 'node'; id: string };

/** AI 通道的独立结果，不进入 CodeNavResult，也不影响任何静态结论的确定性。 */
export interface AiInsight {
    scope: string;
    text: string;
    evidence: number[];
    /** 因为行号越界而被丢弃的引用条数，用于向用户说明过滤情况。 */
    dropped: number;
    model: string;
}

const FUNCTION_LIMIT = 40;
const FLOW_LIMIT = 30;
const TIMELINE_LIMIT = 40;
const COMMENT_LIMIT = 20;
const SLICE_LIMIT = 120;

export function scopeKey(scope: AiScope): string {
    return scope.kind === 'file' ? 'file' : scope.id;
}

/**
 * AI 结果缓存键 = sha256(文件文本 | scope | model | promptVersion)。
 * 文件文本变化或 prompt 版本递增都会让旧结果自然失效。
 */
export function insightCacheKey(fileText: string, scope: AiScope, model: string): string {
    return crypto.createHash('sha256')
        .update(`${fileText}|${scopeKey(scope)}|${model}|${AI_PROMPT_VERSION}`)
        .digest('hex');
}

const intervalCache = new WeakMap<CodeNavResult, [number, number][]>();

/** 合并所有节点的行范围，作为“可定位行”的白名单。 */
function allowedIntervals(result: CodeNavResult): [number, number][] {
    let cache = intervalCache.get(result);
    if (!cache) {
        const spans = result.nodes
            .map(node => [Math.max(1, node.range.startLine), Math.max(1, node.range.endLine)] as [number, number])
            .sort((left, right) => left[0] - right[0]);
        cache = [];
        for (const [start, end] of spans) {
            const last = cache[cache.length - 1];
            if (last && start <= last[1] + 1) { last[1] = Math.max(last[1], end); }
            else { cache.push([start, end]); }
        }
        intervalCache.set(result, cache);
    }
    return cache;
}

function isAllowedLine(spans: [number, number][], line: number): boolean {
    let low = 0;
    let high = spans.length - 1;
    let found = -1;
    while (low <= high) {
        const middle = (low + high) >> 1;
        if (spans[middle][0] <= line) { found = middle; low = middle + 1; }
        else { high = middle - 1; }
    }
    return found >= 0 && line <= spans[found][1];
}

/**
 * 判断某行是否落在本文件任一节点的行范围内。
 * 与 `parseInsight` 的行号校验共用同一套白名单，保证面板只跳转到本文件确认过的行。
 */
export function isKnownLine(result: CodeNavResult, line: number): boolean {
    return Number.isInteger(line) && isAllowedLine(allowedIntervals(result), line);
}

function describeNode(node: NavNode): string {
    const doc = node.doc?.text ? `，注释：${node.doc.text}` : '';
    return `${node.name}（${node.kind}，L${node.range.startLine}-${node.range.endLine}${doc}）`;
}

function sourceSlice(source: string, node: NavNode): string {
    const lines = source.split(/\r?\n/);
    const from = Math.max(1, node.range.startLine);
    const to = Math.min(lines.length, node.range.endLine, from + SLICE_LIMIT - 1);
    const body: string[] = [];
    for (let line = from; line <= to; line++) { body.push(`${line}\t${lines[line - 1]}`); }
    if (node.range.endLine > to) { body.push(`…（已截断，原文到 L${node.range.endLine}）`); }
    return body.join('\n');
}

/**
 * 把静态结果整理成模型可读的骨架上下文。
 * 只带结构化事实与必要切片，不发送整份源码。
 */
export function buildContext(result: CodeNavResult, source: string, scope: AiScope): string {
    const byId = new Map(result.nodes.map(node => [node.id, node] as const));
    const names = (ids: string[]): string[] =>
        ids.map(id => byId.get(id)?.name).filter((name): name is string => Boolean(name));
    const out: string[] = [];

    out.push(`文件：${result.file}（${result.fileType}，共 ${result.meta.totalLines} 行）`);
    if (result.meta.componentName) { out.push(`组件名：${result.meta.componentName}`); }
    if (result.guide.summary) {
        const origin = result.guide.summary.origin === 'comment' ? '作者原话' : '结构事实';
        out.push(`首屏摘要（${origin}）：${result.guide.summary.text}`);
    }
    const entries = names(result.guide.entries);
    if (entries.length) { out.push(`入口：${entries.join('、')}`); }

    if (result.contract.props.length) {
        out.push('Props：' + result.contract.props.map(prop =>
            `${prop.name}${prop.type ? `: ${prop.type}` : ''}${prop.required ? '（必填）' : ''}`).join('、'));
    }
    if (result.contract.emits.length) {
        out.push('对外事件：' + result.contract.emits.map(emit =>
            `${emit.name}${emit.declared ? '' : '（未声明）'}`).join('、'));
    }

    if (result.contract.flows.length) {
        out.push(`状态流转（共 ${result.contract.flows.length} 项）：`);
        for (const flow of result.contract.flows.slice(0, FLOW_LIMIT)) {
            const node = byId.get(flow.id);
            const parts = [`- ${flow.name}（L${node ? node.range.startLine : '?'}）`];
            if (flow.reads.length) { parts.push(`被读取 ${flow.reads.length} 处`); }
            if (flow.writes.length) { parts.push(`被写入 ${flow.writes.length} 处`); }
            if (flow.watches.length) { parts.push(`被 watch ${flow.watches.length} 处`); }
            if (flow.templateLines.length) { parts.push(`模板引用 L${flow.templateLines.join(',')}`); }
            out.push(parts.join('，'));
        }
    }

    if (result.functions.length) {
        out.push(`函数与声明（共 ${result.functions.length} 个）：`);
        for (const fn of result.functions.slice(0, FUNCTION_LIMIT)) {
            const flags = [
                fn.isAsync ? 'async' : '', fn.hasReturn ? '有返回' : '', fn.errorHandling ? '含错误处理' : ''
            ].filter(Boolean).join('/');
            const tail = [
                fn.params.length ? `参数 ${fn.params.join(', ')}` : '',
                fn.callers.length ? `被调用 ${fn.callers.map(ref => `${ref.name}@L${ref.line}`).join('、')}` : '',
                fn.callees.length ? `内部调用 ${fn.callees.map(ref => `${ref.name}@L${ref.line}`).join('、')}` : '',
                fn.writes.length ? `写入 ${fn.writes.map(ref => ref.name).join('、')}` : ''
            ].filter(Boolean).join('；');
            out.push(`- L${fn.line} ${fn.signature}${flags ? ` [${flags}]` : ''}${tail ? `（${tail}）` : ''}`);
        }
    }

    if (result.timeline.length) {
        out.push(`初始化与生命周期（顺序按源码位置推定，共 ${result.timeline.length} 步）：`);
        for (const step of result.timeline.slice(0, TIMELINE_LIMIT)) {
            out.push(`- L${step.line} ${step.kind} ${step.name}`);
        }
    }

    if (result.comments.length) {
        out.push(`作者备注（共 ${result.comments.length} 条）：`);
        for (const note of result.comments.slice(0, COMMENT_LIMIT)) {
            out.push(`- L${note.line} [${note.kind}] ${note.text}`);
        }
    }

    if (scope.kind === 'node') {
        const node = byId.get(scope.id);
        if (node) {
            out.push('', `当前聚焦节点：${describeNode(node)}`);
            out.push('该节点的源码（行号\t内容）：');
            out.push(sourceSlice(source, node));
        } else {
            out.push('', `当前聚焦节点：${scope.id}（未在静态结果中找到）`);
        }
    }

    return out.join('\n');
}

const REFERENCE = /\[L(\d+)(?:\s*-\s*L?(\d+))?\]/g;

/** 只保留能定位到本文件节点的引用；越界引用整条删除并计入 dropped。 */
export function parseInsight(raw: string, result: CodeNavResult, model: string, scope: string): AiInsight {
    const spans = allowedIntervals(result);
    const evidence = new Set<number>();
    let dropped = 0;
    const text = raw.replace(REFERENCE, (match, startText: string, endText?: string) => {
        const start = Number(startText);
        const end = endText ? Number(endText) : start;
        if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) { dropped++; return ''; }
        const kept: number[] = [];
        for (let line = start; line <= end && line <= start + 500; line++) {
            if (isAllowedLine(spans, line)) { kept.push(line); }
        }
        if (!kept.length) { dropped++; return ''; }
        kept.forEach(line => evidence.add(line));
        if (kept.length === end - start + 1) { return match; }
        return `[L${kept[0]}-L${kept[kept.length - 1]}]`;
    });
    return {
        scope,
        text: text.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+\n/g, '\n').trim(),
        evidence: [...evidence].sort((left, right) => left - right),
        dropped,
        model
    };
}
