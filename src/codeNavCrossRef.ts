/**
 * 跨文件证据：反向 import（谁引用了我）与跨文件候选调用点。
 *
 * 性能约束（弱机环境）：
 * - 不建立常驻全库索引，全部按需触发；
 * - 候选发现优先用 git grep（C 实现，遵循 git 索引，未跟踪文件用 --untracked 一并覆盖），
 *   非 git 仓库才降级为「有界 findFiles + 逐个读取」；
 * - 只对命中文件做轻量二次校验（正则抽 import 语句），不调用 Vue 编译器；
 * - 行数、文件数、单文件字节数、耗时全部有上限，且可被 AbortSignal 中断。
 */
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import * as vscode from 'vscode';

/** 参与跨文件检索的源码扩展名。 */
const CODE_EXT = ['.vue', '.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs'];

const IMPORT_HIT_FILES = 40;
const ROWS_LIMIT = 60;
const READ_LIMIT_BYTES = 256 * 1024;
const FALLBACK_FILES = 400;
const GIT_TIMEOUT_MS = 6_000;
const GIT_MAX_MATCH_PER_FILE = 3;

export type Certainty = 'certain' | 'unresolved';

/** 一条「谁引用了我」的结果行。 */
export interface ImporterRow {
    /** 相对工作区根的展示路径 */
    file: string;
    absolute: string;
    line: number;
    /** certain 时是解析出的 import specifier，unresolved 时是命中的原文片段 */
    detail: string;
    certainty: Certainty;
}

/** 一条跨文件符号命中行（候选档，不做语义解析）。 */
export interface SymbolRow {
    file: string;
    absolute: string;
    line: number;
    text: string;
    kind: 'call' | 'ref';
}

export interface CrossRefResult {
    kind: 'importers' | 'symbol';
    /** 展示用查询目标：文件名或符号名 */
    query: string;
    engine: 'git' | 'files';
    durationMs: number;
    importers: ImporterRow[];
    hits: SymbolRow[];
    truncated: boolean;
    note?: string;
}

export interface AliasRule {
    /** 可含一个 `*` 通配 */
    prefix: string;
    /** 绝对路径，可含一个 `*` 通配 */
    target: string;
}

interface RawHit { absolute: string; line: number; text: string; }
interface BackendResult { hits: RawHit[]; engine: 'git' | 'files'; truncated: boolean; note?: string; }

/* ------------------------------------------------------------------ *
 * 纯函数部分（可单测，不依赖 vscode）
 * ------------------------------------------------------------------ */

function isCodeFile(filePath: string): boolean {
    return CODE_EXT.includes(path.extname(filePath).toLowerCase());
}

function isIndexFile(base: string): boolean {
    return /^index(\.[a-z]+)?$/i.test(base);
}

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 生成用于「候选发现」的字面量匹配片段。
 * 引用方可能写成 `./Foo.vue`、`@/components/Foo.vue`（都含 `/Foo.vue`），
 * 也可能省略扩展名 `./Foo`、`@/components/Foo`（含 `/Foo'` 或 `/Foo"`）；
 * 目标文件是 index 时，specifier 指向的是它所在目录名。
 */
export function searchPatternsFor(filePath: string): string[] {
    const base = path.basename(filePath);
    const ext = path.extname(base);
    const stem = base.slice(0, base.length - ext.length);
    const patterns = new Set<string>([`/${base}`]);
    if (!isIndexFile(base)) {
        patterns.add(`/${stem}'`);
        patterns.add(`/${stem}"`);
    } else {
        const dir = path.basename(path.dirname(filePath));
        patterns.add(`/${dir}'`);
        patterns.add(`/${dir}"`);
    }
    return [...patterns];
}

/**
 * 从源码里抽出所有 import / export ... from / require / 动态 import 的 specifier 及其行号。
 * 只做正则级抽取，命中后还要经 resolveSpecifier 校验，误报不会进入「确定」档。
 */
export function parseImportSpecifiers(text: string): { specifier: string; line: number }[] {
    const patterns = [
        /(?:^|[\s;{}(])(?:import|export)\s+[^'"]*?\bfrom\s*['"]([^'"\n]+)['"]/g,
        /(?:^|[\s;{}(])(?:import|export)\s*['"]([^'"\n]+)['"]/g,
        /\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
        /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g
    ];
    const found: { specifier: string; line: number }[] = [];
    const seen = new Set<string>();
    for (const pattern of patterns) {
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(text))) {
            const specifier = match[1];
            // 匹配可能从换行或空格开始，行号要按 specifier 自身的位置算。
            const line = lineAt(text, match.index + match[0].indexOf(specifier));
            const key = `${line}:${specifier}`;
            if (seen.has(key)) { continue; }
            seen.add(key);
            found.push({ specifier, line });
        }
    }
    found.sort((a, b) => a.line - b.line);
    return found;
}

/** 统计 offset 之前的换行数，得到 1 基行号。 */
export function lineAt(text: string, offset: number): number {
    let line = 1;
    for (let i = 0; i < offset && i < text.length; i++) {
        if (text[i] === '\n') { line++; }
    }
    return line;
}

/** 按别名规则把 specifier 换成绝对路径；不匹配返回 undefined。 */
export function aliasTarget(specifier: string, rules: AliasRule[]): string | undefined {
    for (const rule of rules) {
        const star = rule.prefix.indexOf('*');
        if (star === -1) {
            if (specifier === rule.prefix) { return rule.target; }
            continue;
        }
        const head = rule.prefix.slice(0, star);
        const tail = rule.prefix.slice(star + 1);
        if (!specifier.startsWith(head) || !specifier.endsWith(tail)) { continue; }
        if (specifier.length < head.length + tail.length) { continue; }
        const middle = specifier.slice(head.length, specifier.length - tail.length);
        return path.normalize(rule.target.replace('*', middle));
    }
    return undefined;
}

/**
 * 把 specifier 解析成工作区内的真实文件路径。
 * 依次尝试原路径、补源码扩展名、按目录 index 文件兜底；失败返回 undefined（多为第三方包或未配置别名）。
 */
export function resolveSpecifier(
    specifier: string, importerFile: string, rules: AliasRule[], exists: (file: string) => boolean
): string | undefined {
    if (!specifier || /^[a-z]+:/i.test(specifier)) { return undefined; }
    let base: string | undefined;
    if (specifier.startsWith('.')) {
        base = path.resolve(path.dirname(importerFile), specifier);
    } else {
        base = aliasTarget(specifier, rules);
        if (!base) { return undefined; }
    }
    const candidates = [base];
    if (!CODE_EXT.includes(path.extname(base).toLowerCase())) {
        for (const ext of CODE_EXT) { candidates.push(base + ext); }
        for (const ext of CODE_EXT) { candidates.push(path.join(base, 'index' + ext)); }
    }
    return candidates.find(candidate => exists(candidate));
}

/** Windows 上路径大小写不敏感，比较前统一归一化。 */
export function sameFile(a: string, b: string): boolean {
    const left = path.resolve(a);
    const right = path.resolve(b);
    return process.platform === 'win32'
        ? left.toLowerCase() === right.toLowerCase()
        : left === right;
}

/**
 * 逐字符剥掉 JSONC 的注释（字符串内的 `//`、`/*` 不动），再删掉尾逗号。
 * 不能用正则整体替换：tsconfig 里 `"@/*"` 这种别名本身含 `/*`，正则会把它当注释起点。
 */
function stripJsonComments(text: string): string {
    let out = '';
    let quote = false;
    for (let index = 0; index < text.length; index++) {
        const char = text[index];
        if (quote) {
            out += char;
            if (char === '\\') {
                index++;
                if (index >= text.length) { break; }
                out += text[index];
            } else if (char === '"') {
                quote = false;
            }
            continue;
        }
        if (char === '"') { quote = true; out += char; continue; }
        if (char === '/' && text[index + 1] === '/') {
            while (index < text.length && text[index] !== '\n') { index++; }
            out += '\n';
            continue;
        }
        if (char === '/' && text[index + 1] === '*') {
            index += 2;
            while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) { index++; }
            index++;
            continue;
        }
        out += char;
    }
    return out.replace(/,(\s*[}\]])/g, '$1');
}

/** 去掉 JSONC 的注释与尾逗号，便于用 JSON.parse 读取 tsconfig。 */
export function parseJsonc(text: string): Record<string, unknown> | null {
    try {
        return JSON.parse(stripJsonComments(text)) as Record<string, unknown>;
    } catch {
        return null;
    }
}

/**
 * 汇总别名规则：tsconfig / jsconfig 的 paths 与 baseUrl，以及打包配置里的简写别名。
 * 只覆盖常见写法，解析不到的 specifier 会落回「候选」档，不会污染「确定」档。
 */
export function parseAliasRules(root: string, read: (file: string) => string | null): AliasRule[] {
    const rules: AliasRule[] = [];
    for (const name of ['tsconfig.json', 'jsconfig.json']) {
        const raw = read(path.join(root, name));
        if (!raw) { continue; }
        const config = parseJsonc(raw);
        const options = config?.compilerOptions as { baseUrl?: string; paths?: Record<string, string[]> } | undefined;
        if (!options) { continue; }
        const baseUrl = path.resolve(root, options.baseUrl || '.');
        for (const [prefix, values] of Object.entries(options.paths || {})) {
            const first = Array.isArray(values) ? values[0] : undefined;
            if (typeof first !== 'string') { continue; }
            rules.push({ prefix, target: path.resolve(baseUrl, first) });
        }
        if (options.baseUrl) {
            // 未配置 paths 时，baseUrl 本身允许以根路径形式引用（如 `src/utils/x`）
            rules.push({ prefix: `${path.basename(baseUrl)}/*`, target: path.join(baseUrl, '*') });
        }
    }
    // vite / webpack 常见简写：'@': path.resolve(__dirname, 'src') 或 '~': 'src'
    // 这类键只写目录别名（正则只收 `@` / `~` 开头），按 `@/x` 的用法补成 `@/*` 通配。
    for (const name of ['vite.config.ts', 'vite.config.js', 'vite.config.mts', 'vue.config.js', 'webpack.config.js']) {
        const raw = read(path.join(root, name));
        if (!raw) { continue; }
        const pattern = /['"]([@~][\w/-]*)['"]\s*:\s*(?:path\s*\.\s*)?(?:resolve\s*\([^)]*?)?['"]([^'"]+)['"]/g;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(raw))) {
            const key = match[1];
            const prefix = key.includes('*') || key.endsWith('/') ? key : `${key}/*`;
            if (rules.some(rule => rule.prefix === prefix)) { continue; }
            rules.push({ prefix, target: path.join(path.resolve(root, match[2]), '*') });
        }
    }
    return rules;
}

/** 截取命中行原文，用于候选档展示。 */
export function snippetOf(text: string, limit = 80): string {
    return text.replace(/\s+/g, ' ').trim().slice(0, limit);
}

/* ------------------------------------------------------------------ *
 * 后端：候选发现
 * ------------------------------------------------------------------ */

function toAbsolute(root: string, relative: string): string {
    return path.isAbsolute(relative) ? relative : path.resolve(root, relative);
}

function parseGitGrep(stdout: string, root: string): RawHit[] {
    const hits: RawHit[] = [];
    for (const line of stdout.split('\n')) {
        if (!line) { continue; }
        const first = line.indexOf(':');
        if (first === -1) { continue; }
        const second = line.indexOf(':', first + 1);
        if (second === -1) { continue; }
        const lineNumber = Number(line.slice(first + 1, second));
        if (!Number.isInteger(lineNumber)) { continue; }
        const relative = line.slice(0, first);
        hits.push({
            absolute: toAbsolute(root, relative),
            line: lineNumber,
            text: snippetOf(line.slice(second + 1))
        });
    }
    return hits;
}

interface GitOutcome { status: 'ok' | 'empty' | 'missing' | 'failed'; stdout: string; }

function runGit(root: string, args: string[], signal: AbortSignal): Promise<GitOutcome> {
    return new Promise(resolve => {
        const child = execFile('git', args, {
            cwd: root,
            timeout: GIT_TIMEOUT_MS,
            maxBuffer: 8 * 1024 * 1024,
            windowsHide: true
        }, (error, stdout) => {
            if (!error) { return resolve({ status: stdout ? 'ok' : 'empty', stdout }); }
            const code = (error as { code?: unknown }).code;
            if (code === 'ENOENT') { return resolve({ status: 'missing', stdout: '' }); }
            // git grep 无匹配时以 1 退出，属于正常结果
            if (code === 1 && stdout) { return resolve({ status: 'ok', stdout }); }
            resolve({ status: 'failed', stdout: stdout || '' });
        });
        const abort = () => { try { child.kill(); } catch { /* 进程已结束 */ } };
        if (signal.aborted) { abort(); } else { signal.addEventListener('abort', abort, { once: true }); }
    });
}

async function readTextFile(file: string): Promise<string | null> {
    try {
        const stat = await fs.promises.stat(file);
        if (!stat.isFile() || stat.size > READ_LIMIT_BYTES) { return null; }
        return await fs.promises.readFile(file, 'utf-8');
    } catch {
        return null;
    }
}

/** 走 git grep 做候选发现；git 不可用时返回 null，交给有限扫描兜底。 */
async function gitBackend(root: string, args: string[], signal: AbortSignal): Promise<RawHit[] | null> {
    const outcome = await runGit(root, ['-c', 'core.quotePath=false', 'grep', '-n', '-I', '--no-color',
        ...args, '--untracked', '-m', String(GIT_MAX_MATCH_PER_FILE)], signal);
    if (outcome.status === 'missing' || outcome.status === 'failed') { return null; }
    return parseGitGrep(outcome.stdout, root);
}

/** 非 git 仓库时的兜底：有界枚举 + 逐文件按字面量搜索。 */
async function fsBackend(
    root: string, patterns: string[], word: string | undefined, signal: AbortSignal
): Promise<BackendResult> {
    const uris = await vscode.workspace.findFiles(
        '**/*.{vue,js,ts,jsx,tsx,mjs,cjs}', '**/node_modules/**', FALLBACK_FILES);
    const hits: RawHit[] = [];
    const needle = word ? new RegExp(`\\b${escapeRegExp(word)}\\b`, 'g') : undefined;
    let scanned = 0;
    for (const uri of uris) {
        if (signal.aborted) { break; }
        scanned++;
        const text = await readTextFile(uri.fsPath);
        if (!text) { continue; }
        const lines = text.split(/\r?\n/);
        for (let index = 0; index < lines.length; index++) {
            const line = lines[index];
            const matched = needle ? needle.test(line) : patterns.some(item => line.includes(item));
            if (matched) {
                hits.push({ absolute: uri.fsPath, line: index + 1, text: snippetOf(line) });
            }
        }
        if (hits.length > ROWS_LIMIT * 20) { break; }
    }
    return {
        hits,
        engine: 'files',
        truncated: uris.length >= FALLBACK_FILES || hits.length > ROWS_LIMIT * 20,
        note: '当前工作区不是 git 仓库，改为有界文件扫描，未跟踪/超大文件可能被跳过。'
    };
}

/* ------------------------------------------------------------------ *
 * 对外能力
 * ------------------------------------------------------------------ */

export interface ImporterQuery {
    root: string;
    target: string;
    signal: AbortSignal;
}

function toRuleReader(): (file: string) => string | null {
    return (file: string) => {
        try {
            const stat = fs.statSync(file);
            if (!stat.isFile() || stat.size > 128 * 1024) { return null; }
            return fs.readFileSync(file, 'utf-8');
        } catch {
            return null;
        }
    };
}

/**
 * 谁引用了我：候选发现 → 只对命中文件抽 import 语句并解析回本文件。
 * 解析成功进「确定」档，命中但解析不出的进「未确认」档，两档互不混淆。
 */
export async function findImporters(query: ImporterQuery): Promise<CrossRefResult> {
    const started = Date.now();
    const patterns = searchPatternsFor(query.target);
    const read = toRuleReader();
    const rules = parseAliasRules(query.root, read);
    const existsCache = new Map<string, boolean>();
    const exists = (file: string): boolean => {
        const cached = existsCache.get(file);
        if (cached !== undefined) { return cached; }
        let result = false;
        try { result = fs.statSync(file).isFile(); } catch { result = false; }
        existsCache.set(file, result);
        return result;
    };

    let backend: BackendResult;
    const gitHits = await gitBackend(query.root, patterns.flatMap(item => ['-e', item]), query.signal);
    if (gitHits) {
        backend = { hits: gitHits, engine: 'git', truncated: false };
    } else {
        backend = await fsBackend(query.root, patterns, undefined, query.signal);
    }

    const byFile = new Map<string, RawHit[]>();
    for (const hit of backend.hits) {
        if (sameFile(hit.absolute, query.target)) { continue; }
        if (!isCodeFile(hit.absolute)) { continue; }
        const list = byFile.get(hit.absolute);
        if (list) { list.push(hit); } else { byFile.set(hit.absolute, [hit]); }
    }

    const importers: ImporterRow[] = [];
    let truncated = backend.truncated;
    let index = 0;
    for (const [absolute, hits] of byFile) {
        if (index >= IMPORT_HIT_FILES || query.signal.aborted) { truncated = true; break; }
        index++;
        const text = await readTextFile(absolute);
        const matched: ImporterRow[] = [];
        if (text) {
            for (const spec of parseImportSpecifiers(text)) {
                const resolved = resolveSpecifier(spec.specifier, absolute, rules, exists);
                if (resolved && sameFile(resolved, query.target)) {
                    matched.push({
                        file: path.relative(query.root, absolute) || absolute,
                        absolute,
                        line: spec.line,
                        detail: spec.specifier,
                        certainty: 'certain'
                    });
                }
            }
        }
        if (matched.length) {
            importers.push(...matched);
            continue;
        }
        // 命中但解析不出：多为别名未配置或命中在注释/字符串里，按「未确认」保留供人工判断
        importers.push({
            file: path.relative(query.root, absolute) || absolute,
            absolute,
            line: hits[0].line,
            detail: hits[0].text,
            certainty: 'unresolved'
        });
    }
    importers.sort((a, b) => (a.certainty === b.certainty ? 0 : a.certainty === 'certain' ? -1 : 1));

    return {
        kind: 'importers',
        query: path.basename(query.target),
        engine: backend.engine,
        durationMs: Date.now() - started,
        importers: importers.slice(0, ROWS_LIMIT),
        hits: [],
        truncated: truncated || importers.length > ROWS_LIMIT,
        note: backend.note
    };
}

export interface SymbolQuery {
    root: string;
    symbol: string;
    /** 定义所在文件，命中该文件的调用已在函数卡片里展示，这里剔除避免重复 */
    excludeFile?: string;
    signal: AbortSignal;
}

/**
 * 跨文件候选调用点：按符号名做全工作区整词匹配。
 * 这一档刻意不做语义解析（不猜别名、不建索引），只给「可能相关」的位置，供人工确认。
 */
export async function findSymbolSites(query: SymbolQuery): Promise<CrossRefResult> {
    const started = Date.now();
    const callPattern = new RegExp(`\\b${escapeRegExp(query.symbol)}\\s*\\(`);
    let backend: BackendResult;
    const gitHits = await gitBackend(query.root, ['-w', '-F', '-e', query.symbol], query.signal);
    if (gitHits) {
        backend = { hits: gitHits, engine: 'git', truncated: false };
    } else {
        backend = await fsBackend(query.root, [], query.symbol, query.signal);
    }

    const rows: SymbolRow[] = [];
    const seen = new Set<string>();
    for (const hit of backend.hits) {
        if (query.signal.aborted) { break; }
        if (!isCodeFile(hit.absolute)) { continue; }
        if (query.excludeFile && sameFile(hit.absolute, query.excludeFile)) { continue; }
        // import / export 行是引用声明而不是调用点，噪声大，直接剔除
        if (/^\s*(?:import|export)\b/.test(hit.text)) { continue; }
        const key = `${hit.absolute}:${hit.line}`;
        if (seen.has(key)) { continue; }
        seen.add(key);
        rows.push({
            file: path.relative(query.root, hit.absolute) || hit.absolute,
            absolute: hit.absolute,
            line: hit.line,
            text: hit.text,
            kind: callPattern.test(hit.text) ? 'call' : 'ref'
        });
        if (rows.length >= ROWS_LIMIT) { break; }
    }

    return {
        kind: 'symbol',
        query: query.symbol,
        engine: backend.engine,
        durationMs: Date.now() - started,
        importers: [],
        hits: rows,
        truncated: backend.truncated || rows.length >= ROWS_LIMIT,
        note: backend.note
    };
}
