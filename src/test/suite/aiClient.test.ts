import * as assert from 'assert';
import { AiInsightCache, ChatOutcome, Fetcher, chat, gatewayIssue, resolveGateway } from '../../aiClient';
import { AiInsight } from '../../codeNavAi';

const CONFIG = { url: 'http://gateway.test/v1/chat/completions', model: 'test-model', apiKey: 'sk-test' };

function jsonResponse(payload: unknown, status = 200, statusText = 'OK'): Response {
    return new Response(JSON.stringify(payload), { status, statusText });
}

/** 只对 abort 有反应的 fetch：用于验证超时与外部取消，不会真实挂起测试进程。 */
const hanging: Fetcher = (_url, init) => new Promise<Response>((_resolve, reject) => {
    const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    if (init.signal?.aborted) { abort(); return; }
    init.signal?.addEventListener('abort', abort, { once: true });
});

function failureOf(outcome: ChatOutcome): Extract<ChatOutcome, { ok: false }> {
    if (outcome.ok) { throw new Error(`expected a failure outcome, got ${outcome.text}`); }
    return outcome;
}

function insight(scope: string): AiInsight {
    return { scope, text: '解释', evidence: [3], dropped: 0, model: 'test-model' };
}

suite('aiClient', () => {
    test('never calls the gateway when the url or model is missing', async () => {
        let calls = 0;
        const fetcher: Fetcher = async () => { calls++; return jsonResponse({}); };

        const noUrl = failureOf(await chat({ config: { url: '', model: 'm', apiKey: 'k' }, messages: [], fetcher }));
        const noModel = failureOf(await chat({ config: { url: 'http://x', model: '', apiKey: 'k' }, messages: [], fetcher }));

        assert.strictEqual(calls, 0);
        assert.strictEqual(noUrl.failure, 'config');
        assert.strictEqual(noModel.failure, 'config');
        assert.ok(noUrl.message.includes('AI.baseUrl'), noUrl.message);
    });

    test('sends the api key as a bearer token and omits the header when empty', async () => {
        const headers: Record<string, string>[] = [];
        const fetcher: Fetcher = async (_url, init) => {
            headers.push(init.headers as Record<string, string>);
            return jsonResponse({ choices: [{ message: { content: 'ok' } }] });
        };
        await chat({ config: CONFIG, messages: [], fetcher });
        await chat({ config: { ...CONFIG, apiKey: '' }, messages: [], fetcher });
        assert.strictEqual(headers[0].Authorization, 'Bearer sk-test');
        assert.strictEqual(headers[1].Authorization, undefined);
        assert.strictEqual(headers[1]['Content-Type'], 'application/json');
    });

    test('returns the assistant message and strips code fences', async () => {
        const fetcher: Fetcher = async (_url, init) => {
            const body = JSON.parse(String(init.body));
            assert.strictEqual(body.model, 'test-model');
            assert.strictEqual(body.messages.length, 2);
            return jsonResponse({ choices: [{ message: { content: '```text\n它是一个计数器 [L10]\n```' } }] });
        };
        const outcome = await chat({ config: CONFIG, messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }], fetcher });
        assert.ok(outcome.ok, JSON.stringify(outcome));
        assert.strictEqual(outcome.ok && outcome.text, '它是一个计数器 [L10]');
    });

    test('degrades http errors to a message instead of throwing', async () => {
        const fetcher: Fetcher = async () => jsonResponse({ error: 'boom' }, 500, 'Internal Server Error');
        const outcome = failureOf(await chat({ config: CONFIG, messages: [], fetcher }));
        assert.strictEqual(outcome.failure, 'http');
        assert.ok(outcome.message.includes('500'), outcome.message);
    });

    test('treats an empty payload as empty rather than ready', async () => {
        const fetcher: Fetcher = async () => jsonResponse({ choices: [] });
        const outcome = failureOf(await chat({ config: CONFIG, messages: [], fetcher }));
        assert.strictEqual(outcome.failure, 'empty');
    });

    test('times out a hanging request', async () => {
        const outcome = failureOf(await chat({ config: CONFIG, messages: [], fetcher: hanging, timeoutMs: 20 }));
        assert.strictEqual(outcome.failure, 'timeout');
    });

    test('reports an external cancellation as aborted', async () => {
        const controller = new AbortController();
        const pending = chat({
            config: CONFIG, messages: [], fetcher: hanging, timeoutMs: 5_000, signal: controller.signal
        });
        controller.abort();
        const outcome = failureOf(await pending);
        assert.strictEqual(outcome.failure, 'aborted');
    });

    test('normalizes the gateway settings and reports the missing ones', () => {
        assert.deepStrictEqual(
            resolveGateway({ url: ' http://x ', model: ' m ', apiKey: ' k ' }),
            { url: 'http://x', model: 'm', apiKey: 'k' }
        );
        assert.deepStrictEqual(resolveGateway({}), { url: '', model: '', apiKey: '' });
        // apiKey 允许留空：内网网关通常不带鉴权。
        assert.strictEqual(gatewayIssue({ url: 'http://x', model: 'm', apiKey: '' }), '');
        assert.ok(gatewayIssue({ url: '', model: 'm', apiKey: '' }).includes('AI.baseUrl'));
        assert.ok(gatewayIssue({ url: 'http://x', model: '', apiKey: '' }).includes('AI.model'));
    });

    test('caches insights by key and evicts the least recently used entry', () => {
        const cache = new AiInsightCache(2, 60_000);
        cache.set('a', insight('file'));
        cache.set('b', insight('file'));
        assert.strictEqual(cache.get('a')?.scope, 'file');
        cache.set('c', insight('file'));
        assert.strictEqual(cache.get('b'), undefined);
        assert.strictEqual(cache.get('a')?.scope, 'file');
        assert.strictEqual(cache.get('c')?.scope, 'file');
        assert.strictEqual(cache.size, 2);
    });

    test('expires cached insights after the ttl', () => {
        const cache = new AiInsightCache(2, 0);
        cache.set('a', insight('file'));
        assert.strictEqual(cache.get('a'), undefined);
        assert.strictEqual(cache.size, 0);
    });
});
