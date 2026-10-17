import { AiInsight } from './codeNavAi';

/** OpenAI 兼容对话接口的请求消息。 */
export interface ChatMessage {
    role: string;
    content: string;
}

/** 解析后的网关配置：URL、模型名与密钥都已完成去空格处理。 */
export interface AiGatewayConfig {
    url: string;
    model: string;
    /** 按 `Authorization: Bearer` 发送；本地网关不需要密钥时留空。 */
    apiKey: string;
}

/** 可注入的 fetch，便于单测替换为 fake 实现（不发真实请求）。 */
export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

/** 请求超时（毫秒），避免接口异常时面板长时间停留在“生成中”。 */
export const REQUEST_TIMEOUT = 60_000;

/** AI 结果缓存：半小时内、最多 20 条，避免同一文件重复计费。 */
export const INSIGHT_TTL = 30 * 60_000;
export const INSIGHT_LIMIT = 20;

export type AiFailure = 'config' | 'timeout' | 'aborted' | 'http' | 'network' | 'empty';

/** 调用结果统一为可降级的结构，调用方无需 try/catch。 */
export type ChatOutcome =
    | { ok: true; text: string }
    | { ok: false; failure: AiFailure; message: string };

export interface GatewayOptions {
    url?: string;
    model?: string;
    apiKey?: string;
}

/**
 * 归一化网关配置：统一去空格，避免 settings.json 里的尾随空格导致鉴权或路由失败。
 * 纯函数，便于单测。
 */
export function resolveGateway(options: GatewayOptions): AiGatewayConfig {
    return {
        url: (options.url ?? '').trim(),
        model: (options.model ?? '').trim(),
        apiKey: (options.apiKey ?? '').trim()
    };
}

/**
 * 判断网关是否可用；不可用时给出面向用户的提示，且不发起任何请求。
 * `apiKey` 不是必需项：本地或内网网关通常不带鉴权。
 */
export function gatewayIssue(config: AiGatewayConfig): string {
    if (!config.url) { return '未配置大模型接口（AI.baseUrl）'; }
    if (!config.model) { return '未配置大模型名称（AI.model）'; }
    return '';
}

export interface ChatOptions {
    config: AiGatewayConfig;
    messages: ChatMessage[];
    /** 默认使用宿主内置 fetch；单测注入 fake 以避免真实网络请求。 */
    fetcher?: Fetcher;
    timeoutMs?: number;
    /** 外部取消信号：切文件或编辑后作废旧请求。 */
    signal?: AbortSignal;
}

/**
 * 通用 OpenAI 兼容调用：入参消息数组，返回 `choices[0].message.content`。
 * 所有失败都降级为返回值，不抛异常；网关未配置时直接返回，**不发请求**。
 */
export async function chat(options: ChatOptions): Promise<ChatOutcome> {
    const issue = gatewayIssue(options.config);
    if (issue) { return { ok: false, failure: 'config', message: issue }; }

    const fetcher = options.fetcher ?? fetch;
    const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    const onAbort = () => controller.abort();
    if (options.signal?.aborted) { onAbort(); }
    else { options.signal?.addEventListener('abort', onAbort, { once: true }); }

    try {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (options.config.apiKey) { headers.Authorization = `Bearer ${options.config.apiKey}`; }
        const response = await fetcher(options.config.url, {
            method: 'POST',
            headers,
            body: JSON.stringify({ model: options.config.model, messages: options.messages }),
            signal: controller.signal
        });
        if (!response.ok) {
            const detail = await response.text().catch(() => '');
            return {
                ok: false, failure: 'http',
                message: `接口错误 ${response.status} ${response.statusText}${detail ? ' ' + detail.slice(0, 200) : ''}`
            };
        }
        const data = await response.json().catch(() => undefined) as
            { choices?: { message?: { content?: string } }[] } | undefined;
        const content = data?.choices?.[0]?.message?.content?.trim() ?? '';
        if (!content) { return { ok: false, failure: 'empty', message: '模型没有返回内容' }; }
        return { ok: true, text: stripFences(content) };
    } catch (error) {
        if (timedOut) {
            return { ok: false, failure: 'timeout', message: `请求超时（${Math.round(timeoutMs / 1000)}s）` };
        }
        if (options.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
            return { ok: false, failure: 'aborted', message: '已取消' };
        }
        return { ok: false, failure: 'network', message: '网络错误，请检查接口地址与网络连通性' };
    } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
    }
}

/** 剥离模型输出可能包裹的 markdown 代码围栏（cn2en 与 AI 解读共用）。 */
export function stripFences(content: string): string {
    const fence = content.match(/^```[\w-]*\r?\n([\s\S]*?)\r?\n?```$/);
    return fence ? fence[1].trim() : content;
}

/**
 * AI 结果缓存：按 `insightCacheKey` 存 `AiInsight`，带 TTL 与 LRU 淘汰。
 * 命中后不再请求网关，避免重复计费；文件文本变化时键变化，天然失效。
 */
export class AiInsightCache {
    private readonly entries = new Map<string, { insight: AiInsight; expires: number }>();

    constructor(private readonly limit = INSIGHT_LIMIT, private readonly ttlMs = INSIGHT_TTL) { }

    get(key: string): AiInsight | undefined {
        const entry = this.entries.get(key);
        if (!entry) { return undefined; }
        if (entry.expires <= Date.now()) { this.entries.delete(key); return undefined; }
        // 命中后移到末尾，保证淘汰顺序为最近最少使用。
        this.entries.delete(key);
        this.entries.set(key, entry);
        return entry.insight;
    }

    set(key: string, insight: AiInsight): void {
        this.entries.delete(key);
        this.entries.set(key, { insight, expires: Date.now() + this.ttlMs });
        while (this.entries.size > this.limit) {
            this.entries.delete(this.entries.keys().next().value!);
        }
    }

    delete(key: string): void { this.entries.delete(key); }

    clear(): void { this.entries.clear(); }

    get size(): number { return this.entries.size; }
}
