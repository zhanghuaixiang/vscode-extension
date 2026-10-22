import * as assert from 'assert';
import { analyze } from '../../codeNavCore';
import { AI_PROMPT_VERSION, AI_SECTIONS, AI_SYSTEM_PROMPT, buildContext, insightCacheKey, parseInsight } from '../../codeNavAi';
import { CodeNavResult, NavNode } from '../../codeNavTypes';

const source = [
    '<template>',
    '  <button @click="bump">{{ count }}</button>',
    '</template>',
    '<script>',
    'export default {',
    "  name: 'Counter',",
    '  props: { step: { type: Number, default: 1 } },',
    '  data() { return { count: 0 }; },',
    '  methods: {',
    '    bump() { this.count += this.step; },',
    '  },',
    '};',
    '</script>',
    ''
].join('\n');

function node(id: string, kind: NavNode['kind'], start: number, end: number): NavNode {
    return {
        id, name: id, kind,
        range: { startLine: start, startColumn: 1, endLine: end, endColumn: 1 }
    };
}

function withNodes(result: CodeNavResult, nodes: NavNode[]): CodeNavResult {
    return { ...result, nodes, meta: { ...result.meta, totalLines: 30 } };
}

suite('codeNavAi', () => {
    test('builds a file-level context from static facts only', () => {
        const result = analyze(source, 'Counter.vue');
        assert.deepStrictEqual(result.errors, []);
        const context = buildContext(result, source, { kind: 'file' });
        assert.ok(context.includes('文件：Counter.vue（vue，共 '), context);
        assert.ok(context.includes('组件名：Counter'), context);
        assert.ok(context.includes('Props：step: Number'), context);
        assert.ok(context.includes('函数与声明（共 '), context);
        assert.ok(context.includes('bump()'), context);
        assert.ok(context.includes('状态流转'), context);
        assert.ok(!context.includes('行号\t内容'), context);
    });

    test('includes a numbered source slice for a focused node', () => {
        const result = analyze(source, 'Counter.vue');
        const bump = result.functions.find(item => item.name === 'bump')!;
        const context = buildContext(result, source, { kind: 'node', id: bump.id });
        assert.ok(context.includes('当前聚焦节点：bump'), context);
        assert.ok(context.includes('行号\t内容'), context);
        assert.ok(context.includes(`10\t`), context);
        assert.ok(context.includes('this.count += this.step'), context);
    });

    test('keeps only references that land on a known node', () => {
        const result = analyze(source, 'Counter.vue');
        const bump = result.functions[0];
        const insight = parseInsight(
            `它是唯一入口 [L${bump.line}]，另外第 [L2] 行绑定了点击。`, result, 'test-model', 'file');
        assert.deepStrictEqual(insight.evidence, [2, bump.line].sort((a, b) => a - b));
        assert.strictEqual(insight.dropped, 0);
        assert.strictEqual(insight.model, 'test-model');
        assert.strictEqual(insight.scope, 'file');
    });

    test('drops out-of-file and uncovered references', () => {
        const base = analyze(source, 'Counter.vue');
        const result = withNodes(base, [node('a', 'function', 10, 12), node('b', 'function', 20, 22)]);
        const insight = parseInsight('命中 [L11]，越界 [L9999]，空隙 [L16]。', result, 'm', 'file');
        assert.deepStrictEqual(insight.evidence, [11]);
        assert.strictEqual(insight.dropped, 2);
        assert.ok(!insight.text.includes('L9999'), insight.text);
        assert.ok(!insight.text.includes('L16'), insight.text);
        assert.ok(insight.text.includes('[L11]'), insight.text);
    });

    test('merges adjacent node ranges when validating references', () => {
        const base = analyze(source, 'Counter.vue');
        const result = withNodes(base, [
            node('a', 'function', 10, 12), node('c', 'function', 13, 13), node('b', 'function', 20, 22)
        ]);
        const insight = parseInsight('范围 [L10-L13]。', result, 'm', 'file');
        assert.deepStrictEqual(insight.evidence, [10, 11, 12, 13]);
        assert.strictEqual(insight.dropped, 0);
    });

    test('keys the insight cache by file text, scope and model', () => {
        const scope = { kind: 'file' } as const;
        const base = insightCacheKey(source, scope, 'test-model');
        assert.match(base, /^[0-9a-f]{64}$/);
        assert.strictEqual(insightCacheKey(source, scope, 'test-model'), base);
        assert.notStrictEqual(insightCacheKey(source + '\n', scope, 'test-model'), base);
        assert.notStrictEqual(insightCacheKey(source, { kind: 'node', id: 'n1' }, 'test-model'), base);
        assert.notStrictEqual(insightCacheKey(source, scope, 'other-model'), base);
    });

    test('keeps the prompt guardrails for brevity, markdown and locatable references', () => {
        // 解读必须比自己读代码更快：篇幅约束与行号引用是 prompt 的硬约束，改动时要显式确认。
        assert.ok(AI_SYSTEM_PROMPT.includes('严格控制篇幅'), AI_SYSTEM_PROMPT);
        assert.ok(AI_SYSTEM_PROMPT.includes('[L12]'), AI_SYSTEM_PROMPT);
        assert.ok(AI_SYSTEM_PROMPT.includes('markdown'), AI_SYSTEM_PROMPT);
    });

    test('locks the insight output to the four questions a reader actually asks', () => {
        // 四栏是输出协议：改了栏目名就同时改了面板结构，必须递增 AI_PROMPT_VERSION。
        assert.deepStrictEqual([...AI_SECTIONS], ['什么时候会走到', '改动联动', '踩坑点', '建议阅读顺序']);
        for (const section of AI_SECTIONS) {
            assert.ok(AI_SYSTEM_PROMPT.includes(`### ${section}`), section);
        }
        assert.strictEqual(AI_PROMPT_VERSION, 5);
    });
});
