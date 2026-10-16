import { parentPort } from 'worker_threads';
import { probeParse } from './codeNavM0Core';

parentPort?.on('message', (input: { source: string; fileName: string }) => {
    try {
        parentPort?.postMessage({ result: probeParse(input.source, input.fileName) });
    } catch (error) {
        parentPort?.postMessage({ error: error instanceof Error ? error.message : String(error) });
    }
});
