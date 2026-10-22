import * as crypto from 'crypto';
import { CodeNavResult, NavNode } from './codeNavTypes';

/** 修改 prompt 模板或上下文结构时必须递增，用于让已有的 AI 结果缓存失效。 */
export const AI_PROMPT_VERSION = 5;

/**
 * 解读只回答这四个问题：能读到代码的人不缺“这段代码做了什么”，缺的是判断。
 * 栏目名会原样出现在 prompt 里，改动即等于改输出结构，必须同时递增 AI_PROMPT_VERSION。
 */
export const AI_SECTIONS = [
    '什么时候会走到',
    '改动联动',
    '踩坑点',
    '建议阅读顺序'
] as const;

export const AI_SYSTEM_PROMPT = [
    '你是带过项目的资深工程师，同事第一次读这段陌生代码，你在告诉他“换成我我会先知道什么”。',
    '他不缺“这段代码做了什么”：入口、函数清单、状态流转、Props/事件、生命周期时间轴、作者备注，面板上已经列出来了，你复述一遍等于没写。',
    '你只写他读完代码也未必能立刻得出的判断，按下面四栏作答，写不出内容的栏整栏省略，不要为了凑满四栏编造：',
    `### ${AI_SECTIONS[0]}`,
    '什么触发条件或前置状态才会执行到这里；哪种情况下看着会被走到、实际不会。',
    `### ${AI_SECTIONS[1]}`,
    '要改某个行为必须同时改哪几处，只改其中一处会出现什么现象。必须点名具体的函数名、变量名或行号。',
    `### ${AI_SECTIONS[2]}`,
    '哪个分支要满足什么前提才成立，前提不满足时会怎样静默失效；缺失的入参校验、未处理的异常、可能为空的取值、被共享的引用、异步竞态、循环里的重复开销。',
    `### ${AI_SECTIONS[3]}`,
    '先看哪几个符号就能理解主体，每个符号一句话说明为什么先看它。',
    '硬约束：',
    '1. 每条必须是“条件 → 后果”的因果句，并落到具体符号或行号上；“设计合理”“需要注意”这类没有具体所指的话直接删掉。',
    '2. 找不到依据就少写或不写，宁缺毋滥。',
    '3. 只依据下面给出的静态事实与源码作答，不要编造调用关系、读写关系或运行时执行顺序。',
    '4. 每条结论后用 [L12] 或 [L12-L18] 标注依据行号，行号必须来自下面出现过的内容。',
    '5. 严格控制篇幅：文件级每栏最多 2 条、全文不超过 260 字；节点级每栏最多 1 条、全文不超过 140 字；每条一行，不要展开成段落。',
    '6. 用中文 markdown 输出：只写上面四个 “### 栏目名” 与 “- ”列表项，不要别的标题、表格或大段代码块。',
    '下面如果给出“当前聚焦节点”，就只针对该节点作答，不要扩展到整个文件。'
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
/** 文件级上下文里附带的源码总行数上限，控制请求体大小（内网环境不发送整份大文件）。 */
const FILE_SLICE_LIMIT = 160;
/** 文件级上下文里最多附几个节点的源码。 */
const FILE_NODE_LIMIT = 6;

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
 * 文件级上下文附带的重点源码：整份文件不超预算时直接给全文，
 * 否则先给入口节点、再按跨度补几个最大的节点，共用同一份行数预算。
 * 仍然不发送整份大文件：切片总量有固定上限。
 */
function fileSlices(result: CodeNavResult, source: string, byId: Map<string, NavNode>): string {
    const lines = source.split(/\r?\n/);
    if (result.meta.totalLines <= FILE_SLICE_LIMIT) {
        return lines.slice(0, FILE_SLICE_LIMIT)
            .map((line, index) => `${index + 1}\t${line}`).join('\n');
    }
    const picked: NavNode[] = [];
    const push = (node: NavNode | undefined) => {
        if (node && !picked.includes(node)) { picked.push(node); }
    };
    result.guide.entries.forEach(id => push(byId.get(id)));
    for (const node of [...result.nodes].sort((left, right) =>
        (right.range.endLine - right.range.startLine) - (left.range.endLine - left.range.startLine))) {
        if (picked.length >= FILE_NODE_LIMIT) { break; }
        push(node);
    }

    const out: string[] = [];
    let budget = FILE_SLICE_LIMIT;
    for (const node of picked) {
        if (budget <= 0) { break; }
        const from = Math.max(1, node.range.startLine);
        const to = Math.min(lines.length, node.range.endLine, from + budget - 1);
        out.push(`【${node.name} L${from}-L${to}】`);
        for (let line = from; line <= to; line++) { out.push(`${line}\t${lines[line - 1]}`); }
        if (node.range.endLine > to) { out.push(`…（已截断，原文到 L${node.range.endLine}）`); }
        budget -= to - from + 1;
    }
    return out.join('\n');
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
    } else {
        const slices = fileSlices(result, source, byId);
        if (slices) {
            out.push('', '源码（每行以行号开头，大文件只给了重点节点的切片，未列出的部分视为存在但未展示）：');
            out.push(slices);
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
