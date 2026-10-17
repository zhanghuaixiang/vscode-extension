import * as vscode from 'vscode';
import { AiGatewayConfig, gatewayIssue, resolveGateway } from './aiClient';

/** 影响 AI 行为的配置项；其中任意一项变化都需要重建面板状态。 */
export const AI_SETTING_KEYS = ['AI.baseUrl', 'AI.model', 'AI.apiKey', 'AI.enable'];

/** 打开本扩展设置页，用于面板上的「去配置」入口。 */
export const AI_SETTINGS_QUERY = '@ext:zhanghuaixiang.rapid-tools';

export interface AiSettings {
    /** 代码理解面板的「AI 解读」开关；cn2en 翻译与本开关无关。 */
    enabled: boolean;
    gateway: AiGatewayConfig;
    /** 非空表示网关还不可用，可直接当作提示文案展示，且此时不发任何请求。 */
    issue: string;
}

/**
 * 统一读取大模型配置：`AI.baseUrl` / `AI.model` / `AI.apiKey` / `AI.enable` 一组，
 * 供 cn2en 与代码理解面板共用。每次调用都实时读取，用户在设置页改完无需重载窗口。
 */
export function readAiSettings(): AiSettings {
    const config = vscode.workspace.getConfiguration();
    const gateway = resolveGateway({
        url: config.get<string>('AI.baseUrl'),
        model: config.get<string>('AI.model'),
        apiKey: config.get<string>('AI.apiKey')
    });
    return {
        enabled: config.get<boolean>('AI.enable') === true,
        gateway,
        issue: gatewayIssue(gateway)
    };
}
