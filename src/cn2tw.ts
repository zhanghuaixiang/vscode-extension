import { performance } from "node:perf_hooks";

const vscode = require("vscode");
const opencc = require("opencc-js");

export default class Cn2Tw {
    static dictType:{ [key:string]: string } = {
        "hk": "hk",
        "tw": "twp",
        "traditional": "tw"
    };
    static init() {
        vscode.commands.registerCommand('opencc.cn2tw', () => {
            let result = vscode.workspace.getConfiguration().get('Converter.type');
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                const document = editor.document;
                const rrr = editor.selections.map((x: { start: any; end: any; }) => new vscode.Range(x.start, x.end));
                const text = editor.document.getText(rrr[0]);
                let ranges = text ? rrr : [new vscode.Range(document.lineAt(0).range.start, document.lineAt(document.lineCount - 1).range.end)];
                Cn2Tw.translateRange(editor, ranges, 'cn', Cn2Tw.dictType[result]);
            }
        });
        vscode.commands.registerCommand('opencc.tw2cn', () => {
            let result = vscode.workspace.getConfiguration().get('Converter.type');
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                const document = editor.document;
                const rrr = editor.selections.map((x: { start: any; end: any; }) => new vscode.Range(x.start, x.end));
                const text = editor.document.getText(rrr[0]);
                let ranges = text ? rrr : [new vscode.Range(document.lineAt(0).range.start, document.lineAt(document.lineCount - 1).range.end)];
                Cn2Tw.translateRange(editor, ranges, Cn2Tw.dictType[result], 'cn');
            }
        });
    }
    static translateRange(editor: { document: { getText: (arg0: never) => any; }; edit: (arg0: (builder: any) => void) => void; }, ranges:[], from:string, to:string) {
        vscode.window.withProgress({
            title: '简繁字体转换中...',
            location: vscode.ProgressLocation.Notification,
            cancellable: true
        }, async (p: any, ce: { isCancellationRequested: any; }) => {
            const c = opencc.Converter({ from: from, to: to });
            let i = 0;
            const t = ranges.length;
            for (const r of ranges) {
                if (ce.isCancellationRequested) {
                    break;
                }
                i++;
                await new Promise(e => setTimeout(e));
                const text = editor.document.getText(r);
                const lines = text.split(/\b/g);
                const l = lines.length;
                let lastReport = 0;
                for (let li = 0; li < l; li++) {
                    let n = performance.now();
                    if ((n - lastReport) > 100) {
                        lastReport = n;
                        if (ce.isCancellationRequested) {
                            break;
                        }
                        await new Promise(e => setTimeout(e));
                    }
                    if (/[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF]/.test(lines[li])) {
                        lines[li] = lines[li].replace(/[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF]+/g, (s: any) => {
                            const r = c(s);
                            return r;
                        });
                    }
                }
                editor.edit(builder => {
                    builder.replace(r, lines.join(''));
                });
            }
        });
    }
}