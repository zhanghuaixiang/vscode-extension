import * as assert from 'assert';
import { isUntrackedStatus, parseBlamePorcelain, summarizeBlame } from '../../codeNavGit';

/** 取自真实 `git blame --porcelain` 输出：同组首行带行数，组内后续行只有三列。 */
const PORCELAIN = [
    'b42ae7a44e15a20d5a1db264f748eac1cf3b9650 1 1 2',
    'author 张三',
    'author-mail <zhang@example.com>',
    'author-time 1700000000',
    'author-tz +0800',
    'committer 张三',
    'committer-time 1700000000',
    'summary 新增阅读面板',
    'filename src/panel.ts',
    '\timport * as vscode from \'vscode\';',
    'b42ae7a44e15a20d5a1db264f748eac1cf3b9650 2 2',
    '\tconst a = 1;',
    '355167004ae60e935993609ddbcb6abceafa2bdf 3 3 2',
    'author 李四',
    'author-time 1710000000',
    'summary feat: 修一下边界',
    '\tconst b = 2;',
    '355167004ae60e935993609ddbcb6abceafa2bdf 4 4',
    '\t',
    '0000000000000000000000000000000000000000 5 5 1',
    'author Not Committed Yet',
    'author-time 1720000000',
    'summary Version of panel.ts from panel.ts',
    '\tconst c = 3;'
].join('\n');

suite('Code navigation git trace', () => {
    test('groups porcelain lines by commit and counts uncommitted lines', () => {
        const parsed = parseBlamePorcelain(PORCELAIN);
        assert.strictEqual(parsed.totalLines, 5);
        assert.strictEqual(parsed.dirtyLines, 1);
        assert.strictEqual(parsed.commits.length, 2);
        const [first, second] = parsed.commits;
        assert.strictEqual(first.hash, 'b42ae7a44e15a20d5a1db264f748eac1cf3b9650');
        assert.strictEqual(first.author, '张三');
        assert.strictEqual(first.time, 1700000000);
        assert.strictEqual(first.summary, '新增阅读面板');
        assert.strictEqual(first.lines, 2);
        assert.strictEqual(second.author, '李四');
        assert.strictEqual(second.lines, 2);
    });

    test('treats all-zero sha as local change instead of a commit', () => {
        const parsed = parseBlamePorcelain([
            '0000000000000000000000000000000000000000 1 1 1',
            'author Not Committed Yet',
            'summary Version of a.js from a.js',
            '\tconst a = 1;'
        ].join('\n'));
        assert.deepStrictEqual(parsed.commits, []);
        assert.strictEqual(parsed.dirtyLines, 1);
        assert.strictEqual(parsed.totalLines, 1);
    });

    test('returns empty counts for empty blame output', () => {
        const parsed = parseBlamePorcelain('');
        assert.deepStrictEqual(parsed, { commits: [], dirtyLines: 0, totalLines: 0 });
    });

    test('reads untracked state from porcelain status', () => {
        assert.strictEqual(isUntrackedStatus('?? src/new.ts\n'), true);
        // 已跟踪但本地有改动：仍需走 blame，不当作未跟踪
        assert.strictEqual(isUntrackedStatus(' M src/tracked.ts\n'), false);
        assert.strictEqual(isUntrackedStatus(''), false);
    });

    test('aggregates authors by lines and picks the latest commit', () => {
        const parsed = parseBlamePorcelain(PORCELAIN);
        const trace = summarizeBlame(parsed, 12);
        assert.strictEqual(trace.durationMs, 12);
        assert.strictEqual(trace.untracked, false);
        assert.strictEqual(trace.dirtyLines, 1);
        assert.strictEqual(trace.latest?.author, '李四');
        assert.strictEqual(trace.latest?.summary, 'feat: 修一下边界');
        assert.deepStrictEqual(trace.authors.map(item => item.author), ['李四', '张三']);
        assert.deepStrictEqual(trace.authors.map(item => item.lines), [2, 2]);
    });

    test('merges repeated authors and keeps only the top three', () => {
        const commit = (author: string, time: number, lines: number) => ({
            hash: author + time, author, time, summary: '', lines
        });
        const trace = summarizeBlame({
            commits: [
                commit('甲', 100, 1), commit('乙', 200, 1), commit('丙', 300, 1),
                commit('丁', 400, 1), commit('甲', 100, 4)
            ],
            dirtyLines: 0, totalLines: 8
        }, 5);
        assert.strictEqual(trace.authors.length, 3);
        assert.strictEqual(trace.authors[0].author, '甲');
        assert.strictEqual(trace.authors[0].lines, 5);
        // 行数相同时按时间倒序，最新的排前面
        assert.deepStrictEqual(trace.authors.slice(1).map(item => item.author), ['丁', '丙']);
        assert.strictEqual(trace.latest?.author, '丁');
    });
});
