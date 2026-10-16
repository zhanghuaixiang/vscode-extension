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

        test('M0 bundled parsers and worker run in extension host', async function () {
                this.timeout(30_000);
                const extension = vscode.extensions.getExtension('zhanghuaixiang.rapid-tools');
                assert.ok(extension);
                await extension.activate();

                const vue = '<template><button @click="save" /></template><script>export default { methods: { save() {} } }</script>';
                const direct = await vscode.commands.executeCommand<{ fileType: string; hasTemplate: boolean }>(
                        'rapidTools.m0Probe.parse', vue, 'sample.vue'
                );
                const worker = await vscode.commands.executeCommand<typeof direct>(
                        'rapidTools.m0Probe.parse', vue, 'sample.vue', true
                );
                assert.strictEqual(direct.fileType, 'vue');
                assert.strictEqual(direct.hasTemplate, true);
                assert.deepStrictEqual(worker, direct);

                const js = await vscode.commands.executeCommand<{ fileType: string; topLevelDeclarations: number }>(
                        'rapidTools.m0Probe.parse', 'export function save() {}', 'sample.js'
                );
                assert.strictEqual(js.fileType, 'js');
                assert.strictEqual(js.topLevelDeclarations, 1);
        });

        test('M0 Webview renders scripts and packaged image', async function () {
                this.timeout(30_000);
                await vscode.commands.executeCommand('rapidTools.m0Probe.focus');
                for (let attempt = 0; attempt < 100; attempt++) {
                        const status = await vscode.commands.executeCommand<{
                                viewResolved: boolean; rendererReady: boolean; imageLoaded: boolean
                        }>(
                                'rapidTools.m0Probe.status'
                        );
                        if (status.viewResolved && status.rendererReady && status.imageLoaded) {
                                return;
                        }
                        await new Promise(resolve => setTimeout(resolve, 50));
                }
                assert.fail('M0 Webview script or packaged image did not load');
        });
});
