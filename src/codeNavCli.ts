import * as fs from 'fs';
import * as path from 'path';
import { analyze } from './codeNavCore';

const fileName = process.argv[2];
if (!fileName || !/\.(vue|js)$/i.test(fileName) || process.argv.length !== 3) {
    process.stderr.write('Usage: node dist/codeNavCli.js <file.vue|file.js>\n');
    process.exitCode = 1;
} else {
    try {
        const file = path.resolve(fileName);
        const result = analyze(fs.readFileSync(file, 'utf8'), file);
        process.stdout.write(`${JSON.stringify(result)}\n`);
        if (result.errors.length) {
            process.exitCode = 2;
        }
    } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    }
}
