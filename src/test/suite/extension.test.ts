import * as assert from 'assert';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
// import * as myExtension from '../../extension';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('Sample test', () => {
		assert.strictEqual(-1, [1, 2, 3].indexOf(5));
		assert.strictEqual(-1, [1, 2, 3].indexOf(0));
	});

        test('M1 analysis remains available in extension host', async function () {
                this.timeout(30_000);
                const extension = vscode.extensions.getExtension('zhanghuaixiang.rapid-tools');
                assert.ok(extension);
                await extension.activate();

                const vue = '<template><button @click="save" /></template><script>export default { methods: { save() {} } }</script>';
                const direct = await vscode.commands.executeCommand<{
                        fileType: string; template: object | null; paths: { type: string; certainty: string }[]
                }>(
                        'rapidTools.codeNav.analyze', vue, 'sample.vue'
                );
                assert.strictEqual(direct.fileType, 'vue');
                assert.ok(direct.template);
                assert.ok(direct.paths.some(path => path.type === 'event-handler' && path.certainty === 'certain'));

                const js = await vscode.commands.executeCommand<{ fileType: string; script: { exports: string[] } }>(
                        'rapidTools.codeNav.analyze', 'export function save() {}', 'sample.js'
                );
                assert.strictEqual(js.fileType, 'js');
                assert.strictEqual(js.script.exports.length, 1);
        });

        test('M2 Webview renders packaged script and styles', async function () {
                this.timeout(30_000);
                await vscode.commands.executeCommand('rapidTools.codeNav.focus');
                for (let attempt = 0; attempt < 100; attempt++) {
                        const status = await vscode.commands.executeCommand<{
                                rendererReady: boolean
                        }>(
                                'rapidTools.codeNav.debugState'
                        );
                        if (status.rendererReady) {
                                return;
                        }
                        await new Promise(resolve => setTimeout(resolve, 50));
                }
                assert.fail('Code navigation Webview script did not initialize');
        });
});
