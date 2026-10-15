/*
 * @Author: zhanghx
 * @Date: 2022-07-08 09:59:08
 * @LastEditors: Harri harri_1992@163.com
 * @LastEditTime: 2022-07-08 10:00:31
 * @FilePath: \vscode-extension\src\utils\utils.ts
 * @Description: 工具方法库
 * 
 * Copyright (c) 2022 by Harri harri_1992@163.com, All Rights Reserved. 
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

// 按 key 隔离的定时器，避免不同调用方互相取消
const timers = new Map<string, NodeJS.Timeout>();

export default class Utils {
    /**
     * 防抖
     * @param cb 回调
     * @param time 延迟毫秒
     * @param key 防抖分组，不同 key 之间互不影响（必填，防止共用定时器导致回调丢失）
     */
    static debounce(cb: Function, time: number, key: string) {
        const prev = timers.get(key);
        if (prev) {
            clearTimeout(prev);
        }
        timers.set(key, setTimeout(() => {
            timers.delete(key);
            cb();
        }, time));
    }

    /**
     * 获取工作区根目录，未打开工作区时返回 undefined
     */
    static getWorkspaceRoot(): string | undefined {
        return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    }

    /**
     * 获取工作区 package.json 路径，未打开工作区时返回 undefined
     */
    static getPackageJsonPath(): string | undefined {
        const root = Utils.getWorkspaceRoot();
        return root ? path.join(root, "package.json") : undefined;
    }

    /**
     * 安全读取并解析 package.json，失败时返回 null
     */
    static readPackageJson(): any | null {
        const packagePath = Utils.getPackageJsonPath();
        if (!packagePath || !fs.existsSync(packagePath)) {
            return null;
        }
        try {
            return JSON.parse(fs.readFileSync(packagePath, "utf-8"));
        } catch {
            return null;
        }
    }
}
