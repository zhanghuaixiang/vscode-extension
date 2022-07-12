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

let timeout: NodeJS.Timeout | null = null;

export default class Utils {
    static debounce(cb:Function, time:number) {
        clearTimeout(<NodeJS.Timeout>timeout);
        timeout = setTimeout(() => {
            timeout = null;
            cb();
        }, time);
    }
}