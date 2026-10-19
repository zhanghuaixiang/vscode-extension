/**
 * Git 溯源：把「这段代码是谁、什么时候改的，我手上的改动有没有碰它」变成可确认的事实。
 *
 * 性能约束（弱机环境）：
 * - 全部按需触发，只对用户点开的那一个行区间执行 `git blame -L a,b`，不做全库 blame；
 * - 走 git 子进程（C 实现），带超时与 AbortSignal，切换文件即中断；
 * - 非 git 仓库 / 未安装 git / 文件未纳入版本管理，都直接给出结论而不是报错。
 */
import * as path from 'path';
import { execFile } from 'child_process';

export const GIT_TIMEOUT_MS = 6_000;

/** 一次 git blame 归集到的提交。 */
export interface GitCommit {
    hash: string;
    author: string;
    /** Unix 秒 */
    time: number;
    summary: string;
    /** 落在本区间内的行数 */
    lines: number;
}

export interface GitTrace {
    /** 区间总行数 */
    totalLines: number;
    /** 其中属于本地未提交改动的行数 */
    dirtyLines: number;
    /** 文件本身还没被 git 跟踪（从未提交过） */
    untracked: boolean;
    /** 区间内最近一次提交 */
    latest?: GitCommit;
    /** 按占用行数倒序的作者，最多 3 条 */
    authors: GitCommit[];
    durationMs: number;
}

export type GitTraceOutcome =
    | { state: 'ready'; trace: GitTrace }
    | { state: 'unavailable'; reason: string };

export interface GitTraceQuery {
    file: string;
    startLine: number;
    endLine: number;
    signal: AbortSignal;
}

export interface GitOutcome { status: 'ok' | 'empty' | 'missing' | 'failed'; stdout: string; }

/** 统一的 git 执行入口：ENOENT 视为未安装，退出码 1 且有输出时按「正常但无匹配」处理。 */
export function runGit(root: string, args: string[], signal: AbortSignal): Promise<GitOutcome> {
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
            if (code === 1 && stdout) { return resolve({ status: 'ok', stdout }); }
            resolve({ status: 'failed', stdout: stdout || '' });
        });
        const abort = () => { try { child.kill(); } catch { /* 进程已结束 */ } };
        if (signal.aborted) { abort(); } else { signal.addEventListener('abort', abort, { once: true }); }
    });
}

/* ------------------------------------------------------------------ *
 * 纯函数部分（可单测，不依赖 vscode）
 * ------------------------------------------------------------------ */

/**
 * 解析 `git blame --porcelain` 输出。
 * 每个行块以 `<sha> <原始行> <最终行> [<行数>]` 开头，全零 sha 表示该行是本地未提交改动；
 * 作者等元信息只在某个 sha 首次出现时给出一次。
 */
export function parseBlamePorcelain(text: string): {
    commits: GitCommit[]; dirtyLines: number; totalLines: number;
} {
    const byHash = new Map<string, GitCommit>();
    let current = '';
    let dirtyLines = 0;
    let totalLines = 0;
    for (const line of text.split('\n')) {
        if (!line) { continue; }
        const header = /^([0-9a-f]{7,40}) \d+ (\d+)(?: (\d+))?$/.exec(line);
        if (header) {
            current = header[1];
            totalLines++;
            if (/^0+$/.test(current)) {
                dirtyLines++;
                continue;
            }
            const known = byHash.get(current);
            if (known) { known.lines++; } else {
                byHash.set(current, { hash: current, author: '', time: 0, summary: '', lines: 1 });
            }
            continue;
        }
        if (!current || /^0+$/.test(current)) { continue; }
        const commit = byHash.get(current);
        if (!commit) { continue; }
        const space = line.indexOf(' ');
        const key = space === -1 ? line : line.slice(0, space);
        const value = space === -1 ? '' : line.slice(space + 1);
        if (key === 'author') { commit.author = commit.author || value; }
        else if (key === 'author-time') { commit.time = commit.time || Number(value) || 0; }
        else if (key === 'summary') { commit.summary = commit.summary || value; }
    }
    return { commits: [...byHash.values()], dirtyLines, totalLines };
}

/**
 * `git status --porcelain -- <file>` 只关心一件事：文件有没有被 git 跟踪。
 * 未跟踪时输出以 `??` 开头（` M` 开头表示已跟踪但本地有改动，仍需走 blame）。
 */
export function isUntrackedStatus(text: string): boolean {
    return text.split('\n').some(line => line.startsWith('??'));
}

/** 把 blame 结果整理成面板要用的摘要：最近一次提交 + 主要作者（按行数）。 */
export function summarizeBlame(
    parsed: { commits: GitCommit[]; dirtyLines: number; totalLines: number }, durationMs: number
): GitTrace {
    const byAuthor = new Map<string, GitCommit>();
    for (const commit of parsed.commits) {
        const known = byAuthor.get(commit.author);
        if (known) { known.lines += commit.lines; } else { byAuthor.set(commit.author, { ...commit }); }
    }
    const authors = [...byAuthor.values()].sort((a, b) => (b.lines - a.lines) || (b.time - a.time));
    const latest = [...parsed.commits].sort((a, b) => b.time - a.time)[0];
    return {
        totalLines: parsed.totalLines,
        dirtyLines: parsed.dirtyLines,
        untracked: false,
        latest,
        authors: authors.slice(0, 3),
        durationMs
    };
}

/* ------------------------------------------------------------------ *
 * 对外能力
 * ------------------------------------------------------------------ */

/** 未跟踪文件也要能回答「还没提交过」，所以这里不当作错误。 */
function untrackedTrace(totalLines: number, durationMs: number): GitTrace {
    return {
        totalLines, dirtyLines: totalLines, untracked: true, authors: [], durationMs
    };
}

/**
 * 对一段行区间（通常是函数体）做 blame，并顺带确认文件是否有本地改动。
 * 只读操作，不改动仓库，也不会产生索引或缓存文件。
 */
export async function traceRange(query: GitTraceQuery): Promise<GitTraceOutcome> {
    const started = Date.now();
    const startLine = Math.max(1, Math.floor(query.startLine));
    const endLine = Math.max(startLine, Math.floor(query.endLine));
    const dir = path.dirname(query.file);
    const name = path.basename(query.file);

    const inside = await runGit(dir, ['rev-parse', '--is-inside-work-tree'], query.signal);
    if (inside.status === 'missing') {
        return { state: 'unavailable', reason: '未找到 git 命令，无法回溯改动来源。' };
    }
    if (inside.status !== 'ok' || inside.stdout.trim() !== 'true') {
        return { state: 'unavailable', reason: '当前文件不在 git 仓库中，无法回溯改动来源。' };
    }

    const range = endLine - startLine + 1;
    // 未跟踪文件在 blame 里必然报错，先问一次状态，省掉一次必然失败的子进程。
    const status = await runGit(dir, ['-c', 'core.quotePath=false', 'status', '--porcelain', '--', name],
        query.signal);
    if (status.status === 'ok' && isUntrackedStatus(status.stdout)) {
        return { state: 'ready', trace: untrackedTrace(range, Date.now() - started) };
    }

    const blame = await runGit(dir, ['-c', 'core.quotePath=false', 'blame', '--porcelain',
        '-L', `${startLine},${endLine}`, '--', name], query.signal);
    if (blame.status === 'missing') {
        return { state: 'unavailable', reason: '未找到 git 命令，无法回溯改动来源。' };
    }
    if (blame.status !== 'ok') {
        return { state: 'unavailable', reason: '本文件在 git 中没有可回溯的提交记录。' };
    }
    return {
        state: 'ready',
        trace: summarizeBlame(parseBlamePorcelain(blame.stdout), Date.now() - started)
    };
}
