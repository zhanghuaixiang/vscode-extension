import * as crypto from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { Worker } from 'worker_threads';
import { probeParse, ProbeResult } from './codeNavM0Core';

export function registerCodeNavM0Probe(context: vscode.ExtensionContext): void {
    let viewResolved = false;
    let pingCount = 0;
    let rendererReady = false;
    let imageLoaded = false;

    context.subscriptions.push(vscode.window.registerWebviewViewProvider('rapidTools.m0Probe', {
        resolveWebviewView(view) {
            viewResolved = true;
            const imageRoot = vscode.Uri.joinPath(context.extensionUri, 'images');
            view.webview.options = {
                enableScripts: true,
                localResourceRoots: [imageRoot]
            };
            const image = view.webview.asWebviewUri(vscode.Uri.joinPath(imageRoot, 'icon.png'));
            const nonce = crypto.randomBytes(16).toString('hex');
            view.webview.html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${view.webview.cspSource}; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <style nonce="${nonce}">body { font-family: var(--vscode-font-family); padding: 12px; } img { width: 32px; }</style>
</head>
<body>
  <img id="probe-image" src="${image}" alt="rapid-tools">
  <p>M0 Webview 资源与消息探针</p>
  <button id="ping">Ping</button><span id="status"></span>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const image = document.getElementById('probe-image');
    const reportImage = () => vscode.postMessage({ type: 'image', loaded: image.naturalWidth > 0 });
    image.addEventListener('load', reportImage);
    image.addEventListener('error', reportImage);
    if (image.complete) reportImage();
    document.getElementById('ping').addEventListener('click', () => vscode.postMessage({ type: 'ping' }));
    window.addEventListener('message', event => {
      if (event.data.type === 'pong') document.getElementById('status').textContent = 'Pong';
    });
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
            context.subscriptions.push(view.webview.onDidReceiveMessage(message => {
                if (message?.type === 'ping') {
                    pingCount++;
                    void view.webview.postMessage({ type: 'pong' });
                } else if (message?.type === 'ready') {
                    rendererReady = true;
                } else if (message?.type === 'image') {
                    imageLoaded = message.loaded === true;
                }
            }));
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand(
        'rapidTools.m0Probe.parse',
        (source: string, fileName: string, useWorker = false): ProbeResult | Promise<ProbeResult> => {
            if (!useWorker) {
                return probeParse(source, fileName);
            }
            return new Promise((resolve, reject) => {
                const worker = new Worker(path.join(context.extensionPath, 'dist', 'codeNavM0Worker.js'));
                worker.once('message', (message: { result?: ProbeResult; error?: string }) => {
                    void worker.terminate();
                    if (message.error) {
                        reject(new Error(message.error));
                    } else if (message.result) {
                        resolve(message.result);
                    } else {
                        reject(new Error('M0 worker returned no result'));
                    }
                });
                worker.once('error', reject);
                worker.postMessage({ source, fileName });
            });
        }
    ));
    context.subscriptions.push(vscode.commands.registerCommand(
        'rapidTools.m0Probe.status',
        () => ({ viewResolved, rendererReady, imageLoaded, pingCount })
    ));
}
