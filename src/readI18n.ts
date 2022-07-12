import * as vscode from 'vscode';
import utils from './utils/utils';
let path = require("path");
let fs = require("fs");

const rootPath = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
const packagePath = path.join(vscode.workspace.rootPath || rootPath, "package.json");

const taskTab =  vscode.window.createOutputChannel("i18n-rapid");

export default class ReadI18n {
    private static hover:any = null;
    private static i18nConf:{[key:string]: any} = {};
    private static selection:string = "";
    private static originData:ORIGINDATA = {enData:{}, cnData:{}};
    static init(packageJSON:string) {
        let config = JSON.parse(packageJSON);
        ReadI18n.i18nConf = config.i18nConfig;
        taskTab.appendLine("i18nConfig: " + JSON.stringify(ReadI18n.i18nConf));

        ReadI18n.bindEvent();
        ReadI18n.setOriginData();
    }
    
    static bindEvent():void {
        if(!ReadI18n.i18nConf.validPath) {
            return;
        }
        // 注册气泡
        ReadI18n.hover = vscode.languages.registerHoverProvider({
            pattern: ReadI18n.i18nConf.validPath
        }, {
            async provideHover(document, position, token) {
                const editor = vscode.window.activeTextEditor;
                if (!editor) {
                    return; 
                }
                const selectText = document.getText(editor.selection);
                ReadI18n.selection = selectText.trim();
                ReadI18n.selection = ReadI18n.matchRegexOfSelection(/^"(.+)"$/);
                ReadI18n.selection = ReadI18n.matchRegexOfSelection(/^'(.+)'$/);
                ReadI18n.selection = ReadI18n.matchRegexOfSelection(/(.+)"$/);
                ReadI18n.selection = ReadI18n.matchRegexOfSelection(/(.+)'$/);
                if(ReadI18n.selection.startsWith("'") || ReadI18n.selection.startsWith("\"")) {
                    ReadI18n.selection = ReadI18n.selection.substring(1,);
                }
                
                const text = await ReadI18n.getTexts();
                return new vscode.Hover(<string>text);
            }
        });

        const {cnPath, enPath} = ReadI18n.i18nConf;
        cnPath && fs.watch(path.join(rootPath, cnPath), (type:string, fileName:string)=>{
            utils.debounce(()=>{
                ReadI18n.setOriginData(fileName, "cn");
            }, 300);
        });

        enPath && fs.watch(path.join(rootPath, enPath), (type:string, fileName:string)=>{
            utils.debounce(()=>{
                ReadI18n.setOriginData(fileName, "en");
            }, 300);
        });
    }

    private static matchRegexOfSelection (regex: RegExp):string {
        if(ReadI18n.selection.match(regex)) {
            const result = ReadI18n.selection.match(regex);
            return result && result[1] || ReadI18n.selection;
        } else {
            return ReadI18n.selection;
        }
    }
    static async setOriginData(fileName?:string, type?:string) {
        if(!ReadI18n.i18nConf.cnPath && !ReadI18n.i18nConf.enPath) {
            return;
        }
        const {cnPath, enPath} = ReadI18n.i18nConf;
        var fileNameCn:string = "", fileNameEn:string = "";
        if(type === "cn") {
            fileNameCn = <string>fileName;
        }else if(type === "en") {
            fileNameEn = <string>fileName;
        }
        let cnData = await ReadI18n.getData(path.join(rootPath, cnPath), fileNameCn, "cn");
        let enData = await ReadI18n.getData(path.join(rootPath, enPath), fileNameEn, "en");
        ReadI18n.originData = {
            cnData,
            enData
        };
    }
    // 遍历文件获取数据
    static getData(dir:string, fileName:string, flag:string) {
        return new Promise((resolve, reject)=>{
            if(fileName) {
                const { cnData, enData } = ReadI18n.originData;
                let dataTemp = flag === "cn" ? cnData : enData;
                let filePath = path.join(dir, fileName);
                ReadI18n.analyzeFileContent(filePath, fileName, (data:{[key:string]:any}) => {
                    Object.assign(dataTemp, data);
                });
            }else{
                let dataTemp = {};
                fs.readdir(dir, (error:any, files:[])=>{
                    if(error) {
                        reject(error);
                        return;
                    }
                    files.forEach(async (name:string) => {
                        const filePath = path.join(dir, name);
                        ReadI18n.analyzeFileContent(filePath, name, (data:{[key:string]:any}) => {
                            Object.assign(dataTemp, data);
                        });
                    });
                    resolve(dataTemp);
                });
            }
            
        });
    }
    /**
     * 解析文件内容，解析成JSON
     * @param filePath 文件路径
     * @param fileName 文件名称，用于记录异常情况
     * @param cb 回调函数，将JSON数据回调给上方
     */
    private static analyzeFileContent(filePath:string, fileName:string, cb:Function) {
        let tempData = fs.readFileSync(filePath, "utf8");
        // 替换换行符
        tempData = 
            tempData.replace(/(\/\*.+\*\/)/g, "")
            .replace(/\s\/\/.+\r\n/g, "")
            .replace(/\n/g, "")
            .replace(/\r/g, "")
            .replace(/<img.+?\/(?:img)?>/g, "");
        const matchData = tempData.match(/{(.*)}/)[0];
        const matchDataTrim = matchData.trim();
        const matchDefault = matchDataTrim.match(/(.+)export\s+default\s+\{(.+)\};?$/);
        // 兼容 export default {xxx}写法
        if(matchDefault) {
            let transferData = matchDefault[1];
            transferData = transferData.endsWith(";")?transferData.substring(0, transferData.length-1):transferData;
            const str = matchDefault[2];
            try {
                const data = eval(`({${str.trim()}:${transferData}})`);
                // const data = new Function(`return {${str.trim()}:${transferData}}`).apply(null);
                cb(data);
            } catch (error) {
                taskTab.appendLine(fileName + " in exception");
                return;
            }
        }else{
            try {
                // eval函数加括号会有返回值
                const data = eval(`(${matchData})`);
                // const data = new Function(`return ${matchData}`).apply(null);
                cb(data);
            } catch (error) {
                taskTab.appendLine(fileName + " in exception");
                return;
            }
        }
        taskTab.appendLine(`${filePath} read over;`);
    }
    static getTexts () {
        return new Promise((resolve, reject) => {
            const selection =  ReadI18n.selection;
            const selections = selection.split(".");
            // 深copy国际化源数据
            let tempData = JSON.parse(JSON.stringify(ReadI18n.originData));
            // 将选中的字符串以.进行拆分，拆分后遍历
            for (let i = 0; i < selections.length; i++) {
                // 获取key值
                const key = selections[i];
                const item = tempData['cnData'][key];
                if(item) {
                    if(typeof item === "string") {
                        const cnT = tempData['cnData'][key];
                        const enT = tempData['enData'][key];
                        const markdownString = new vscode.MarkdownString();
                        markdownString.appendMarkdown(
                            "### i18n"
                        );
                        markdownString.appendMarkdown(
                            `\n\n --- \n\n 【**中**】 ${cnT}`
                        );
                        markdownString.appendMarkdown(
                            `\n\n --- \n\n 【**英**】 ${enT}`
                        );
                        tempData = markdownString;
                    }else{
                        tempData = {
                            cnData: tempData['cnData'][key],
                            enData: tempData['enData'][key]
                        };
                    }
                } else {
                    reject(null);
                }
            }
            
            resolve(tempData);
        }).catch(()=>{
            ReadI18n.selection = "";
        });
    }
    // 销毁hover实例
    private static disposeHover() {
        if(ReadI18n.hover) {
            ReadI18n.hover.dispose();
            ReadI18n.hover = null;
        }
    }
}

type ORIGINDATA = {
    cnData: any,
    enData: any
};