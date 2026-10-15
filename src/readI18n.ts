import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import utils from './utils/utils';

const taskTab = vscode.window.createOutputChannel("i18n-rapid");

// 语言标识对应的悬停展示名，未收录的标识直接展示原文
const LANG_LABELS: { [lang: string]: string } = {
    cn: "中",
    en: "英",
    tw: "繁"
};

export default class ReadI18n {
    private static hover: vscode.Disposable | null = null;
    private static watchers: fs.FSWatcher[] = [];
    private static langs: string[] = [];
    private static basePath = "";
    private static originData: { [lang: string]: { [key: string]: any } } = {};

    static init() {
        const config = vscode.workspace.getConfiguration();
        // 默认关闭，需显式开启；关闭时释放已有注册并清空数据
        if (config.get<boolean>("I18n.enable") !== true) {
            ReadI18n.dispose();
            ReadI18n.langs = [];
            ReadI18n.originData = {};
            return;
        }
        ReadI18n.langs = config.get<string[]>("I18n.langs") || [];
        ReadI18n.basePath = config.get<string>("I18n.basePath") || "";
        const validPath = config.get<string>("I18n.validPath") || "";
        taskTab.appendLine(`i18n 配置: langs=[${ReadI18n.langs.join(",")}], basePath=${ReadI18n.basePath}, validPath=${validPath}`);

        // 支持重复调用（settings 变化后重新初始化），先释放上一次的注册
        ReadI18n.dispose();
        ReadI18n.bindEvent(validPath);
        ReadI18n.reload();
    }

    static bindEvent(validPath: string): void {
        if (validPath) {
            // 注册气泡
            ReadI18n.hover = vscode.languages.registerHoverProvider({ pattern: validPath }, {
                provideHover(document, position) {
                    const key = ReadI18n.resolveKey(document, position);
                    const content = ReadI18n.getTexts(key);
                    return content ? new vscode.Hover(content) : undefined;
                }
            });
        }

        const root = utils.getWorkspaceRoot();
        if (!root) {
            return;
        }
        for (const lang of ReadI18n.langs) {
            ReadI18n.watchDir(root, lang);
        }
    }

    /**
     * 监听单个语言的国际化目录（basePath/语言标识）
     * @param root 工作区根目录
     * @param lang 语言标识
     */
    private static watchDir(root: string, lang: string) {
        const dir = path.join(root, ReadI18n.basePath, lang);
        if (!fs.existsSync(dir)) {
            taskTab.appendLine(`i18n 目录不存在，跳过监听: ${dir}`);
            return;
        }
        try {
            const watcher = fs.watch(dir, () => {
                utils.debounce(() => ReadI18n.reload(lang), 300, `i18n-${lang}`);
            });
            ReadI18n.watchers.push(watcher);
        } catch {
            taskTab.appendLine(`i18n 目录监听失败: ${dir}`);
        }
    }

    /**
     * 解析鼠标悬停位置对应的 i18n key
     * 光标在引号内时取完整引号内容，否则取该位置的单词（支持点分 key）
     */
    private static resolveKey(document: vscode.TextDocument, position: vscode.Position): string {
        const lineText = document.lineAt(position.line).text;
        const linePrefix = lineText.substring(0, position.character);
        const quoted = linePrefix.match(/(["'])([^"']*)$/);
        let key: string;
        if (quoted) {
            // 光标位于引号内：向左右两侧扩展，取到闭合引号（或行尾）为止的完整内容
            const start = position.character - quoted[2].length;
            const close = lineText.indexOf(quoted[1], position.character);
            key = lineText.substring(start, close === -1 ? lineText.length : close);
        } else {
            const keyChar = /[\w.$-]/;
            let start = position.character;
            let end = position.character;
            while (start > 0 && keyChar.test(lineText.charAt(start - 1))) {
                start--;
            }
            while (end < lineText.length && keyChar.test(lineText.charAt(end))) {
                end++;
            }
            key = lineText.substring(start, end);
        }
        return key.trim().replace(/^["']|["']$/g, "");
    }

    /**
     * 重新加载国际化数据
     * 始终整侧全量重载：增量合并无法感知文件中已被删除的 key
     * @param lang 触发重载的语言标识，不传则全部重载
     */
    static reload(lang?: string) {
        const root = utils.getWorkspaceRoot();
        if (!root || !ReadI18n.langs.length || !ReadI18n.basePath) {
            return;
        }
        const next: { [lang: string]: { [key: string]: any } } = {};
        for (const item of ReadI18n.langs) {
            next[item] = !lang || lang === item
                ? ReadI18n.readDir(path.join(root, ReadI18n.basePath, item))
                : ReadI18n.originData[item] || {};
        }
        ReadI18n.originData = next;
    }

    /**
     * 遍历目录，汇总其中所有文件的国际化数据
     */
    private static readDir(dir: string): { [key: string]: any } {
        const result: { [key: string]: any } = {};
        let names: string[];
        try {
            names = fs.readdirSync(dir);
        } catch {
            taskTab.appendLine(`目录读取失败: ${dir}`);
            return result;
        }
        for (const name of names) {
            const data = ReadI18n.analyzeFileContent(path.join(dir, name), name);
            if (data) {
                Object.assign(result, data);
            }
        }
        return result;
    }

    /**
     * 解析文件内容为对象，失败返回 null
     * @param filePath 文件路径
     * @param fileName 文件名称，用于记录异常情况
     */
    private static analyzeFileContent(filePath: string, fileName: string): { [key: string]: any } | null {
        let tempData: string;
        try {
            // 跳过子目录、已删除文件，避免抛出未捕获异常
            if (!fs.statSync(filePath).isFile()) {
                return null;
            }
            tempData = fs.readFileSync(filePath, "utf8");
        } catch {
            taskTab.appendLine(`${fileName} 读取失败`);
            return null;
        }

        // 替换换行符
        tempData =
            tempData.replace(/(\/\*.+\*\/)/g, "")
                .replace(/\s\/\/.+\r\n/g, "")
                .replace(/\n/g, "")
                .replace(/\r/g, "")
                .replace(/<img.+?\/(?:img)?>/g, "");

        const matched = tempData.match(/{(.*)}/);
        if (!matched) {
            taskTab.appendLine(`${fileName} 未匹配到有效内容`);
            return null;
        }

        const matchDataTrim = matched[0].trim();
        // 兼容 export default {xxx} 写法
        const matchDefault = matchDataTrim.match(/(.+)export\s+default\s+\{(.+)\};?$/);
        let source = matchDataTrim;
        if (matchDefault) {
            let transferData = matchDefault[1];
            transferData = transferData.endsWith(";") ? transferData.substring(0, transferData.length - 1) : transferData;
            source = `{${matchDefault[2].trim()}:${transferData}}`;
        }

        const data = ReadI18n.parseObject(source, fileName);
        if (data) {
            taskTab.appendLine(`${filePath} read over;`);
        }
        return data;
    }

    /**
     * 将源码字符串解析为对象
     * 优先按纯 JSON 解析；仅在受信任的工作区中，才对 JS 模块写法降级求值
     */
    private static parseObject(source: string, fileName: string): { [key: string]: any } | null {
        try {
            return JSON.parse(source);
        } catch {
            // 含注释、尾逗号或变量引用，无法按 JSON 解析
        }
        if (!vscode.workspace.isTrusted) {
            taskTab.appendLine(`${fileName} 需要在受信任的工作区中才能解析`);
            return null;
        }
        try {
            return new Function(`return (${source});`)();
        } catch {
            taskTab.appendLine(`${fileName} in exception`);
            return null;
        }
    }

    /**
     * 根据 key 生成悬停提示内容，未命中时返回 undefined
     * 以配置的第一个语言为基准，key 必须存在于基准语言中
     */
    static getTexts(key: string): vscode.MarkdownString | undefined {
        if (!key || !ReadI18n.langs.length) {
            return undefined;
        }
        const primary = ReadI18n.langs[0];
        const values: { [lang: string]: any } = {};
        for (const lang of ReadI18n.langs) {
            values[lang] = ReadI18n.originData[lang];
        }
        for (const segment of key.split(".")) {
            const cur = values[primary];
            if (!cur || typeof cur !== "object" || !(segment in cur)) {
                return undefined;
            }
            for (const lang of ReadI18n.langs) {
                values[lang] = values[lang] && typeof values[lang] === "object" ? values[lang][segment] : undefined;
            }
        }
        if (typeof values[primary] !== "string") {
            return undefined;
        }
        const markdownString = new vscode.MarkdownString();
        markdownString.appendMarkdown("### i18n");
        for (const lang of ReadI18n.langs) {
            const label = LANG_LABELS[lang] || lang;
            const value = typeof values[lang] === "string" ? values[lang] : "";
            markdownString.appendMarkdown(`\n\n --- \n\n 【**${label}**】 ${value}`);
        }
        return markdownString;
    }

    /**
     * 释放 hover 实例与文件监听
     */
    static dispose() {
        if (ReadI18n.hover) {
            ReadI18n.hover.dispose();
            ReadI18n.hover = null;
        }
        ReadI18n.watchers.forEach(watcher => {
            try {
                watcher.close();
            } catch {
                // 忽略重复关闭
            }
        });
        ReadI18n.watchers = [];
    }
}
