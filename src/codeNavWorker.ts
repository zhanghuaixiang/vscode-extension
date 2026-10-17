import { parentPort } from 'worker_threads';
import { analyze } from './codeNavCore';

parentPort?.on('message', (input: { source: string; fileName: string }) => {
    try {
        parentPort?.postMessage({ result: analyze(input.source, input.fileName) });
    } catch (error) {
        parentPort?.postMessage({ error: error instanceof Error ? error.message : String(error) });
    }
});
