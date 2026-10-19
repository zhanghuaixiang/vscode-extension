/**
 * 组件契约校验：拿本文件声明的 props / emits，去「确定引用本文件」的父组件里核对实际传参与监听。
 *
 * 性能约束（弱机环境）：
 * - 只在用户点击时执行，复用跨文件检索的候选发现（git grep / 有界扫描），不另建索引；
 * - 父组件文件数、单文件大小、结论条数都有上限，全程支持 AbortSignal；
 * - 只回答「模板里写了什么 vs 本文件声明了什么」，不推断运行时行为，也不改代码。
 */
import * as fs from 'fs';
import * as path from 'path';
import { findImporters } from './codeNavCrossRef';

const PARENT_LIMIT = 12;
const READ_LIMIT_BYTES = 256 * 1024;
const ISSUE_LIMIT = 40;

/** 不属于 props / emits 的属性：透传属性、指令与内置绑定。 */
const SPECIAL_ATTRS = new Set(['class', 'style', 'key', 'ref', 'is', 'slot', 'id', 'title', 'role', 'name']);

export interface ParsedAttribute {
    name: string;
    kind: 'prop' | 'event' | 'special';
    dynamic: boolean;
}

export interface TagUsage {
    tag: string;
    line: number;
    attrs: string;
}

export interface ContractIssue {
    kind: 'missing-required' | 'unknown-prop' | 'unknown-event';
    certainty: 'certain' | 'unresolved';
    line: number;
    detail: string;
}

export interface FileReport {
    file: string;
    absolute: string;
    usages: number;
    issues: ContractIssue[];
}

export interface ContractCheckResult {
    kind: 'contract';
    query: string;
    durationMs: number;
    parents: number;
    usages: number;
    reports: FileReport[];
    truncated: boolean;
    note?: string;
}

export interface ContractQuery {
    root: string;
    target: string;
    props: { name: string; required: boolean }[];
    emits: string[];
    signal: AbortSignal;
}

/* ------------------------------------------------------------------ *
 * 纯函数部分（可单测，不依赖 vscode）
 * ------------------------------------------------------------------ */

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `FooBar` / `fooBar` → `foo-bar`，模板里两种写法都可能出现。 */
export function kebabCase(name: string): string {
    return name
        .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
        .replace(/[_\s]+/g, '-')
        .toLowerCase();
}

/** 一个本地绑定名可能在模板里写成 `<FooBar>` 或 `<foo-bar>`。 */
export function tagCandidatesFor(binding: string): string[] {
    if (!binding) { return []; }
    const kebab = kebabCase(binding);
    return kebab === binding ? [binding] : [binding, kebab];
}

/** 没有可用绑定名（如 `export { default } from`）时的兜底：用文件名当标签名。 */
export function tagsFromFile(fileName: string): string[] {
    const stem = path.basename(fileName, path.extname(fileName));
    if (!stem || stem === 'index') { return []; }
    return tagCandidatesFor(stem);
}

/**
 * 从 import / export 语句里取本地绑定名。
 * `import Foo from './Foo.vue'` → Foo；`import { Bar as Baz } from ...` → Baz；
 * `import './Foo.vue'`（纯副作用）→ 空数组。
 */
export function importBindings(text: string, specifier: string): string[] {
    const quoted = `['"]${escapeRegExp(specifier)}['"]`;
    const pattern = new RegExp(`(?:import|export)\\s+([^'"]*?)\\bfrom\\s*${quoted}`, 'g');
    const found: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text))) {
        const clause = match[1].replace(/^type\s+/, '').trim();
        if (!clause) { continue; }
        const named = /\{([^}]*)\}/.exec(clause);
        if (named) {
            for (const entry of named[1].split(',')) {
                const alias = /\bas\s+([\w$]+)/.exec(entry);
                const plain = entry.trim().replace(/^type\s+/, '').trim();
                if (alias) { found.push(alias[1]); }
                // `export { default } from ...` 里的 default 不是标签名
                else if (/^[\w$]+$/.test(plain) && plain !== 'default') { found.push(plain); }
            }
        }
        const namespace = /\*\s+as\s+([\w$]+)/.exec(clause);
        if (namespace) { found.push(namespace[1]); }
        const fallback = /^([\w$]+)\s*(?:,|$)/.exec(clause);
        if (fallback && fallback[1] !== 'default') { found.push(fallback[1]); }
    }
    return [...new Set(found)];
}

/**
 * 抽出模板里对指定标签的使用点及其属性串。
 * 属性区按引号感知的方式扫到标签结束，`<Foo :title="a > b">` 不会被 `>` 截断。
 */
export function findTagUsages(source: string, tags: string[]): TagUsage[] {
    const usages: TagUsage[] = [];
    if (!tags.length) { return usages; }
    const pattern = new RegExp(`<(${tags.map(escapeRegExp).join('|')})(?=[\\s/>])`, 'g');
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source))) {
        const start = match.index + match[0].length;
        let index = start;
        let quote = '';
        while (index < source.length) {
            const char = source[index];
            if (quote) {
                if (char === quote) { quote = ''; }
            } else if (char === '"' || char === "'") {
                quote = char;
            } else if (char === '>') {
                break;
            }
            index++;
        }
        const attrs = source.slice(start, index);
        // 属性区里出现裸 `<` 说明命中的不是标签（多见于脚本里的比较运算），丢弃。
        if (attrs.includes('<')) { continue; }
        usages.push({ tag: match[1], line: lineIndex(source, match.index), attrs });
    }
    return usages;
}

function lineIndex(source: string, offset: number): number {
    let line = 1;
    for (let index = 0; index < offset && index < source.length; index++) {
        if (source[index] === '\n') { line++; }
    }
    return line;
}

/** 解析属性串：区分静态/动态 prop、事件监听、指令与透传属性。 */
export function parseTagAttributes(attrs: string): { attributes: ParsedAttribute[]; spread: boolean } {
    const attributes: ParsedAttribute[] = [];
    let spread = false;
    // 属性值一并吃掉，否则引号里的内容会被当成下一个属性名。
    const pattern = /[:@#]?[A-Za-z_$][\w$.:-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(attrs))) {
        const raw = match[0];
        const equal = raw.indexOf('=');
        const name = (equal === -1 ? raw : raw.slice(0, equal)).trim();
        if (name === 'v-bind') { spread = true; }
        else if (name.startsWith('v-bind:')) {
            const target = name.slice('v-bind:'.length).split('.')[0];
            if (target) { attributes.push({ name: target, kind: 'prop', dynamic: true }); }
        } else if (name.startsWith('v-on:')) {
            const target = name.slice('v-on:'.length).split('.')[0];
            if (target) { attributes.push({ name: target, kind: 'event', dynamic: false }); }
        } else if (name.startsWith('v-') || name.startsWith('#')) {
            attributes.push({ name, kind: 'special', dynamic: false });
        } else if (name.startsWith(':')) {
            const target = name.slice(1).split('.')[0];
            if (target) { attributes.push({ name: target, kind: 'prop', dynamic: true }); }
        } else if (name.startsWith('@')) {
            const target = name.slice(1).split('.')[0];
            if (target) { attributes.push({ name: target, kind: 'event', dynamic: false }); }
        } else if (SPECIAL_ATTRS.has(name) || name.startsWith('data-') || name.startsWith('aria-')) {
            attributes.push({ name, kind: 'special', dynamic: false });
        } else {
            attributes.push({ name, kind: 'prop', dynamic: false });
        }
    }
    return { attributes, spread };
}

/**
 * 单次使用点的核对结论：
 * - 必填 prop 在本使用点没出现 → 确定问题（除非父组件用了 `v-bind` 整体透传）；
 * - 传了未声明的 prop / 监听了未声明的事件 → 候选，需人工确认（可能来自 mixin、$attrs 透传或原生事件）。
 */
export function checkUsage(
    usage: TagUsage, props: { name: string; required: boolean }[], emits: string[]
): ContractIssue[] {
    const { attributes, spread } = parseTagAttributes(usage.attrs);
    const declared = new Set(props.map(item => item.name));
    const events = new Set(emits);
    const passed = new Set<string>();
    const reported = new Set<string>();
    const issues: ContractIssue[] = [];

    for (const attribute of attributes) {
        if (attribute.kind === 'special') { continue; }
        if (attribute.kind === 'event') {
            const key = `e:${attribute.name}`;
            if (events.has(attribute.name) || reported.has(key)) { continue; }
            reported.add(key);
            issues.push({
                kind: 'unknown-event', certainty: 'unresolved', line: usage.line,
                detail: `<${usage.tag}> 监听了本文件未声明的事件「${attribute.name}」`
            });
            continue;
        }
        passed.add(attribute.name);
        const key = `p:${attribute.name}`;
        if (declared.has(attribute.name) || reported.has(key)) { continue; }
        reported.add(key);
        issues.push({
            kind: 'unknown-prop', certainty: 'unresolved', line: usage.line,
            detail: `<${usage.tag}> 传入了本文件未声明的 prop「${attribute.name}」`
        });
    }

    if (!spread) {
        for (const prop of props) {
            if (!prop.required || passed.has(prop.name)) { continue; }
            issues.push({
                kind: 'missing-required', certainty: 'certain', line: usage.line,
                detail: `<${usage.tag}> 未传入必填 prop「${prop.name}」`
            });
        }
    }
    return issues;
}

/* ------------------------------------------------------------------ *
 * 对外能力
 * ------------------------------------------------------------------ */

async function readText(file: string): Promise<string | null> {
    try {
        const stat = await fs.promises.stat(file);
        if (!stat.isFile() || stat.size > READ_LIMIT_BYTES) { return null; }
        return await fs.promises.readFile(file, 'utf-8');
    } catch {
        return null;
    }
}

/** 只检查「确定引用本文件」的 .vue 父组件；未确认命中不参与，避免结论被噪声污染。 */
export async function verifyContract(query: ContractQuery): Promise<ContractCheckResult> {
    const started = Date.now();
    const fileName = path.basename(query.target);
    const importers = await findImporters({
        root: query.root, target: query.target, signal: query.signal
    });
    // 标签使用点只从 SFC 模板里取：脚本文件里的 JSX / 比较运算会让正则误判。
    const parents = importers.importers
        .filter(row => row.certainty === 'certain' && /\.vue$/i.test(row.absolute));

    const reports: FileReport[] = [];
    let usages = 0;
    let issues = 0;
    let truncated = importers.truncated;
    let inspected = 0;

    for (const row of parents) {
        if (query.signal.aborted) { break; }
        if (inspected >= PARENT_LIMIT) { truncated = true; break; }
        inspected++;
        const text = await readText(row.absolute);
        if (text === null) { continue; }
        const bindings = importBindings(text, row.detail);
        const tags = bindings.length ? [...new Set(bindings.flatMap(tagCandidatesFor))] : tagsFromFile(fileName);
        if (!tags.length) { continue; }
        const found: ContractIssue[] = [];
        let count = 0;
        for (const usage of findTagUsages(text, tags)) {
            count++;
            for (const issue of checkUsage(usage, query.props, query.emits)) {
                if (issues >= ISSUE_LIMIT) { truncated = true; break; }
                found.push(issue);
                issues++;
            }
        }
        if (!count) { continue; }
        usages += count;
        reports.push({
            file: path.relative(query.root, row.absolute) || row.absolute,
            absolute: row.absolute,
            usages: count,
            issues: found
        });
    }

    return {
        kind: 'contract',
        query: fileName,
        durationMs: Date.now() - started,
        parents: inspected,
        usages,
        reports,
        truncated,
        note: reports.length ? undefined
            : '没有在「确定引用本文件」的 .vue 父组件里找到对应的标签使用点，暂无可核对内容。'
    };
}
