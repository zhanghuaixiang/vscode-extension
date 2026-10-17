import * as path from 'path';
import { Worker } from 'worker_threads';
import { CodeNavResult } from './codeNavTypes';

export class AnalysisCancelled extends Error {
    constructor() { super('Analysis cancelled'); }
}

export interface AnalysisTask {
    promise: Promise<CodeNavResult>;
    cancel(): void;
}

export function runAnalysis(extensionPath: string, source: string, fileName: string): AnalysisTask {
    const worker = new Worker(path.join(extensionPath, 'dist', 'codeNavWorker.js'));
    let cancel: () => void = () => undefined;
    const promise = new Promise<CodeNavResult>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => finish(new Error('代码分析超时，请缩小文件或稍后重试')), 60_000);
        const finish = (error?: Error, result?: CodeNavResult) => {
            if (settled) { return; }
            settled = true;
            clearTimeout(timer);
            void worker.terminate();
            if (error) { reject(error); }
            else if (result) { resolve(result); }
            else { reject(new Error('分析 worker 未返回结果')); }
        };
        worker.once('message', (message: { result?: CodeNavResult; error?: string }) => {
            finish(message.error ? new Error(message.error) : undefined, message.result);
        });
        worker.once('error', error => finish(error));
        worker.once('exit', code => {
            if (code !== 0) { finish(new Error(`分析 worker 退出，代码 ${code}`)); }
        });
        cancel = () => finish(new AnalysisCancelled());
        worker.postMessage({ source, fileName });
    });
    return { promise, cancel: () => cancel() };
}
