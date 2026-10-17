import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

interface PanelState {
    status: string;
    uri?: string;
    version?: number;
    renderedFile?: string;
    rendererReady: boolean;
    refreshCount: number;
    workerRuns: number;
    cacheHits: number;
    mode: string;
    focusName?: string;
    focusMessage: string;
    nodes?: { id: string; name: string; line: number }[];
}

async function panelState(): Promise<PanelState> {
    return vscode.commands.executeCommand<PanelState>('rapidTools.codeNav.debugState');
}

async function waitFor(predicate: (state: PanelState) => boolean): Promise<PanelState> {
    for (let attempt = 0; attempt < 100; attempt++) {
        const state = await panelState();
        if (predicate(state)) { return state; }
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.fail('Code navigation panel did not reach the expected state');
}

suite('Code navigation panel', () => {
    test('discards an in-flight result after switching files', async function () {
        this.timeout(30_000);
        const extension = vscode.extensions.getExtension('zhanghuaixiang.rapid-tools');
        assert.ok(extension);
        await extension.activate();
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'code-nav-race-'));
        try {
            const slow = path.join(directory, 'slow.js');
            const current = path.join(directory, 'current.js');
            fs.writeFileSync(slow, Array.from({ length: 4000 }, (_, index) =>
                `export function slow${index}() { return ${index}; }\n`).join(''));
            fs.writeFileSync(current, 'export function current() {}\n');
            await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(slow));
            const active = await vscode.workspace.openTextDocument(current);
            await vscode.window.showTextDocument(active);
            const state = await waitFor(item => item.status === 'ready'
                && item.uri === active.uri.toString() && item.renderedFile === active.uri.toString());
            assert.ok(state.nodes?.some(node => node.name === 'current'));
            assert.ok(!state.nodes?.some(node => node.name.startsWith('slow')));
        } finally {
            try {
                fs.rmSync(directory, { recursive: true, force: true });
            } catch (error) {
                if (!['EPERM', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) {
                    throw error;
                }
            }
        }
    });

    test('switches files, sees unsaved edits, refreshes and reveals validated nodes', async function () {
        this.timeout(30_000);
        const extension = vscode.extensions.getExtension('zhanghuaixiang.rapid-tools');
        assert.ok(extension);
        await extension.activate();
        await vscode.commands.executeCommand('rapidTools.codeNav.focus');

        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'code-nav-panel-'));
        try {
            const first = path.join(directory, 'one.js');
            const second = path.join(directory, 'two.vue');
            const unsupported = path.join(directory, 'notes.txt');
            fs.writeFileSync(first, 'export function first() { return 1; }\n');
            fs.writeFileSync(second, '<template><button @click="save" /></template>\n<script setup>function save() {}</script>');
            fs.writeFileSync(unsupported, 'notes');
            const a = await vscode.workspace.openTextDocument(first);
            const b = await vscode.workspace.openTextDocument(second);
            const notes = await vscode.workspace.openTextDocument(unsupported);

            let aEditor = await vscode.window.showTextDocument(a);
            await waitFor(state => state.status === 'ready' && state.uri === a.uri.toString()
                && state.renderedFile === a.uri.toString());
            await vscode.window.showTextDocument(b);
            await waitFor(state => state.status === 'ready' && state.uri === b.uri.toString()
                && state.renderedFile === b.uri.toString());
            aEditor = await vscode.window.showTextDocument(a);
            const cached = await waitFor(state => state.status === 'ready' && state.uri === a.uri.toString()
                && state.renderedFile === a.uri.toString());
            assert.ok(cached.cacheHits > 0, 'returning to unchanged A should reuse its snapshot');

            await aEditor.edit(edit => edit.replace(a.lineAt(0).range, 'export function changed() { return 2; }'));
            await vscode.window.showTextDocument(b);
            await waitFor(state => state.uri === b.uri.toString() && state.status === 'ready');
            await vscode.window.showTextDocument(a);
            const updated = await waitFor(state => state.status === 'ready' && state.version === a.version
                && Boolean(state.nodes?.some(node => node.name === 'changed')));
            assert.ok(!updated.nodes?.some(node => node.name === 'first'));

            const before = updated.refreshCount;
            const workerRuns = updated.workerRuns;
            await vscode.commands.executeCommand('rapidTools.codeNav.refresh');
            const refreshed = await waitFor(state => state.refreshCount === before + 1 && state.status === 'ready');
            assert.ok(refreshed.workerRuns > workerRuns, 'manual refresh must bypass the cache');
            const changed = refreshed.nodes?.find(node => node.name === 'changed');
            assert.ok(changed);
            const focusedEditor = await vscode.window.showTextDocument(a);
            focusedEditor.selection = new vscode.Selection(0, 18, 0, 18);
            await vscode.commands.executeCommand('rapidTools.codeNav.focusFunction');
            const focused = await waitFor(state => state.mode === 'function' && state.focusName === 'changed');
            assert.strictEqual(focused.focusMessage, '');
            await vscode.commands.executeCommand('rapidTools.codeNav.showFile');
            await waitFor(state => state.mode === 'file');
            await vscode.commands.executeCommand('rapidTools.codeNav.revealNode', changed.id);
            assert.strictEqual(vscode.window.activeTextEditor?.selection.active.line, changed.line - 1);

            await vscode.window.showTextDocument(notes);
            const empty = await waitFor(state => state.status === 'unsupported'
                && state.uri === notes.uri.toString() && state.renderedFile === notes.uri.toString());
            assert.strictEqual(empty.nodes, undefined);
        } finally {
            try {
                fs.rmSync(directory, { recursive: true, force: true });
            } catch (error) {
                // VS Code may still watch open test documents on Windows.
                if (!['EPERM', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) {
                    throw error;
                }
            }
        }
    });
});
