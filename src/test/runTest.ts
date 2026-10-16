import * as path from 'path';

import { runTests } from '@vscode/test-electron';

async function main() {
	try {
		// The folder containing the Extension Manifest package.json
		// Passed to `--extensionDevelopmentPath`
		const extensionDevelopmentPath = process.env.VSCODE_EXTENSION_PATH
			|| path.resolve(__dirname, '../../');

		// The path to test runner
		// Passed to --extensionTestsPath
		const extensionTestsPath = path.resolve(__dirname, './suite/index');

		// Download VS Code, unzip it and run the integration test
		await runTests({
			extensionDevelopmentPath,
			extensionTestsPath,
			vscodeExecutablePath: process.env.VSCODE_EXECUTABLE_PATH
		});
	} catch (err) {
		console.error('Failed to run tests');
		process.exit(1);
	}
}

main();
