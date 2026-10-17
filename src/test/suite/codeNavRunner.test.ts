import * as assert from 'assert';
import * as vscode from 'vscode';
import { AnalysisCancelled, runAnalysis } from '../../codeNavRunner';

suite('Code navigation worker', () => {
    test('returns a snapshot and settles a cancelled task', async function () {
        this.timeout(30_000);
        const extension = vscode.extensions.getExtension('zhanghuaixiang.rapid-tools');
        assert.ok(extension);
        const source = 'export function ready() { return 1; }';
        const task = runAnalysis(extension.extensionPath, source, 'ready.js');
        const result = await task.promise;
        assert.ok(result.nodes.some(node => node.name === 'ready'));

        const cancelled = runAnalysis(extension.extensionPath,
            'export function stale() {}', 'stale.js');
        cancelled.cancel();
        await assert.rejects(cancelled.promise, AnalysisCancelled);
    });
});
