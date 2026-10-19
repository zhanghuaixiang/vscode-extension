import * as assert from 'assert';
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { analyze } from '../../codeNavCore';
import { CodeNavResult } from '../../codeNavTypes';

function node(result: CodeNavResult, kind: string, name: string) {
    const match = result.nodes.find(item => item.kind === kind && item.name === name);
    assert.ok(match, `missing ${kind} ${name}`);
    return match;
}

suite('Code navigation core', () => {
    test('Vue Options API connects events, methods and state writes with original lines', () => {
        const source = [
            '<template>',
            '  <Panel><button @click="save">Save</button></Panel>',
            '  <button @click="save(); other()">Dynamic</button>',
            '</template>',
            '<script>',
            'export default {',
            "  name: 'Demo',",
            "  props: ['id'],",
            '  data() { return { count: 0 }; },',
            '  methods: {',
            '    save() { this.count++; this.persist(); },',
            '    persist() {}',
            '  }',
            '};',
            '</script>'
        ].join('\n');
        const result = analyze(source, 'Demo.vue');
        assert.deepStrictEqual(result.errors, []);
        assert.strictEqual(result.meta.componentName, 'Demo');
        assert.strictEqual(result.template?.rootEl, 'Panel');
        assert.strictEqual(result.template?.tree[0].children[0].tag, 'button');
        assert.strictEqual(node(result, 'prop', 'id').range.startLine, 8);
        const save = node(result, 'method', 'save');
        const persist = node(result, 'method', 'persist');
        const count = node(result, 'state', 'count');
        assert.strictEqual(save.range.startLine, 11);
        assert.ok(result.paths.some(path => path.type === 'event-handler' && path.to === save.id
            && path.evidence.startLine === 2 && path.certainty === 'certain'));
        assert.ok(result.paths.some(path => path.type === 'event-handler'
            && path.certainty === 'unresolved' && path.evidence.startLine === 3));
        assert.ok(result.paths.some(path => path.type === 'calls' && path.from === save.id
            && path.to === persist.id && path.evidence.startLine === 11));
        assert.ok(result.paths.some(path => path.type === 'writes' && path.from === save.id
            && path.to === count.id && path.evidence.startLine === 11));
        assert.ok(result.paths.some(path => path.type === 'exports' && path.certainty === 'certain'));
    });

    test('Vue script setup TypeScript handler stays on its original source line', () => {
        const source = [
            '<template>',
            '  <button @click="save">Save</button>',
            '</template>',
            '<script setup lang="ts">',
            'const count: number = 0;',
            'function save() { return count; }',
            '</script>'
        ].join('\n');
        const result = analyze(source, 'Setup.vue');
        assert.deepStrictEqual(result.errors, []);
        const save = node(result, 'function', 'save');
        assert.strictEqual(save.range.startLine, 6);
        assert.ok(result.paths.some(path => path.type === 'event-handler' && path.to === save.id
            && path.evidence.startLine === 2));
    });

    test('Vue configured watchers and computed fields remain navigable', () => {
        const source = [
            '<script>',
            'export default {',
            '  computed: { total: { get() { return 1; } } },',
            "  watch: { count: 'onCount' },",
            '  methods: { onCount() {} },',
            '  mounted() {}',
            '};',
            '</script>'
        ].join('\n');
        const result = analyze(source, 'Options.vue');
        assert.deepStrictEqual(result.errors, []);
        assert.strictEqual(node(result, 'computed', 'total').range.startLine, 3);
        assert.strictEqual(node(result, 'watch', 'count').range.startLine, 4);
        assert.strictEqual(node(result, 'hook', 'mounted').range.startLine, 6);
    });

    test('JS ESM exports and local calls resolve, while external calls remain unknown', () => {
        const source = [
            "import { request } from './api';",
            'export const save = (value) => helper(value);',
            'function helper(value) { request(value); return value; }',
            'export { helper as forwarded };'
        ].join('\n');
        const result = analyze(source, 'service.js');
        assert.deepStrictEqual(result.errors, []);
        const save = node(result, 'function', 'save');
        const helper = node(result, 'function', 'helper');
        assert.strictEqual(result.imports.length, 1);
        assert.strictEqual(result.script.exports.length, 2);
        assert.ok(result.paths.some(path => path.type === 'exports' && path.to === save.id
            && path.evidence.startLine === 2));
        assert.ok(result.paths.some(path => path.type === 'exports' && path.to === helper.id
            && path.evidence.startLine === 4));
        assert.ok(result.paths.some(path => path.type === 'calls' && path.from === save.id
            && path.to === helper.id && path.evidence.startLine === 2));
        assert.ok(result.paths.some(path => path.type === 'calls' && path.from === helper.id
            && path.targetName === 'request' && path.certainty === 'unresolved'));
    });

    test('TypeScript files parse types and exports and report fileType ts', () => {
        const source = [
            "import type { Order } from './types';",
            'interface Draft { id: string; total: number }',
            'export type Amount = number;',
            'export function total(orders: Order[]): number {',
            '  const draft: Draft = { id: "a", total: 0 };',
            '  return orders.length + draft.total;',
            '}',
            'export const label = (value: string): string => value.trim();'
        ].join('\n');
        const result = analyze(source, 'order.ts');
        assert.deepStrictEqual(result.errors, []);
        assert.strictEqual(result.fileType, 'ts');
        assert.strictEqual(result.template, null);
        assert.strictEqual(result.imports.length, 1);
        // 类型别名不是运行时导出，只有函数与箭头函数算作导出。
        assert.strictEqual(result.script.exports.length, 2);
        const total = node(result, 'function', 'total');
        assert.strictEqual(total.range.startLine, 4);
        assert.ok(result.paths.some(path => path.type === 'exports' && path.to === total.id));
        assert.ok(result.paths.some(path => path.type === 'exports'
            && path.to === node(result, 'function', 'label').id));
    });

    test('CommonJS exports and shadowed or dynamic calls do not invent edges', () => {
        const source = [
            'const helper = () => 1;',
            'function run(helper) { helper(); return service[action](); }',
            'exports.run = run;',
            'module.exports.helper = helper;'
        ].join('\n');
        const result = analyze(source, 'legacy.js');
        assert.strictEqual(result.script.exports.length, 2);
        assert.ok(result.paths.some(path => path.type === 'exports' && path.to === node(result, 'function', 'run').id));
        assert.ok(result.paths.some(path => path.type === 'exports' && path.to === node(result, 'function', 'helper').id));
        assert.ok(result.paths.filter(path => path.type === 'calls').every(path => path.certainty === 'unresolved'));
    });

    test('Class methods, object methods, require imports and returns keep navigable nodes', () => {
        const source = [
            "const api = require('./api');",
            'export class Counter {',
            '  increment() { return 1; }',
            '}',
            'const helpers = {',
            '  reset() { return 0; }',
            '};'
        ].join('\n');
        const result = analyze(source, 'counter.js');
        assert.deepStrictEqual(result.errors, []);
        assert.strictEqual(result.imports.length, 1);
        assert.strictEqual(node(result, 'class', 'Counter').children?.length, 1);
        assert.strictEqual(node(result, 'classMethod', 'increment').range.startLine, 3);
        assert.strictEqual(node(result, 'method', 'reset').range.startLine, 6);
        assert.ok(result.paths.some(path => path.type === 'returns' && path.evidence.startLine === 3));
        assert.ok(result.paths.some(path => path.type === 'exports'
            && path.to === node(result, 'class', 'Counter').id));
    });

    test('Plain JS objects are not mislabeled as Vue components', () => {
        const result = analyze("export default { name: 'helper', run() { return 1; } };", 'helper.js');
        assert.strictEqual(result.meta.componentName, null);
        assert.strictEqual(node(result, 'method', 'run').name, 'run');
        assert.ok(result.paths.some(path => path.type === 'exports' && path.certainty === 'certain'));
    });

    test('Anonymous default function and class exports still have targets', () => {
        for (const source of [
            'export default function() { return 1; }',
            'export default class { run() { return 1; } }',
            'export default () => 1;'
        ]) {
            const result = analyze(source, 'default.js');
            assert.deepStrictEqual(result.errors, []);
            assert.ok(result.paths.some(edge => edge.type === 'exports'
                && edge.certainty === 'certain' && result.nodes.some(item => item.id === edge.to)));
        }
    });

    test('Destructured exports remain visible without invented targets', () => {
        const result = analyze('export const { value } = source;', 'destructured.js');
        assert.strictEqual(result.script.exports.length, 1);
        assert.ok(result.paths.some(edge => edge.type === 'exports' && edge.certainty === 'unresolved'));
    });

    test('Template local scopes do not claim a handler with the same name', () => {
        const source = [
            '<template><button v-for="save in saves" @click="save">Save</button></template>',
            '<script>export default { methods: { save() {} } }</script>'
        ].join('\n');
        const result = analyze(source, 'scope.vue');
        assert.ok(result.paths.some(path => path.type === 'event-handler' && path.certainty === 'unresolved'
            && path.reason?.includes('局部作用域')));
    });

    test('Syntax errors keep recoverable Vue template and script section', () => {
        const source = [
            '<template><div><button @click="go" /></div></template>',
            '<script>',
            'export function go( {',
            '</script>'
        ].join('\n');
        const result = analyze(source, 'broken.vue');
        assert.strictEqual(result.template?.rootEl, 'div');
        assert.ok(result.nodes.some(item => item.kind === 'script'));
        assert.ok(result.errors.some(error => error.block === 'script' && error.line === 4));
    });

    test('Author comments, JSDoc tags and TODOs keep their original lines', () => {
        const source = [
            '<template>',
            '  <!-- 订单卡片：支持批量选择 -->',
            '  <div>',
            '    <!-- TODO: 骨架屏 -->',
            '    <button @click="submit">提交</button>',
            '  </div>',
            '</template>',
            '<script>',
            '/**',
            ' * 订单卡片组件',
            ' * @deprecated 请改用 OrderPanel',
            ' */',
            'export default {',
            '  props: {',
            '    // 订单编号，必填',
            '    id: String,',
            '    size: Number // 每页数量',
            '  },',
            '  data() { return {',
            '    count: 0 // 已选数量',
            '  }; },',
            '  methods: {',
            '    /**',
            '     * 提交订单',
            '     * @param force 是否强制提交',
            '     * @returns 服务端订单号',
            '     */',
            '    submit(force) { this.count++; return 1; },',
            '    // FIXME: 依赖后端字段，先写死',
            '    reset() {}',
            '  }',
            '};',
            '</script>'
        ].join('\n');
        const result = analyze(source, 'OrderCard.vue');
        assert.deepStrictEqual(result.errors, []);
        assert.strictEqual(result.doc?.text, '订单卡片组件');
        assert.strictEqual(result.doc?.line, 9);
        assert.deepStrictEqual(result.doc?.tags, [{ tag: 'deprecated', text: '请改用 OrderPanel' }]);
        assert.strictEqual(result.guide.summary?.origin, 'comment');
        assert.strictEqual(result.guide.summary?.text, '订单卡片组件');
        assert.deepStrictEqual(result.guide.summary?.evidence, [9]);

        const submit = node(result, 'method', 'submit');
        assert.strictEqual(submit.doc?.text, '提交订单');
        assert.deepStrictEqual(submit.doc?.tags, [
            { tag: 'param', text: 'force 是否强制提交' },
            { tag: 'returns', text: '服务端订单号' }
        ]);
        assert.strictEqual(node(result, 'prop', 'id').doc?.text, '订单编号，必填');
        assert.strictEqual(node(result, 'method', 'reset').doc, undefined,
            'TODO / FIXME 一类标记属于待办清单，不作为函数说明');
        assert.deepStrictEqual(result.comments.map(item => [item.kind, item.text, item.line]), [
            ['note', '订单卡片：支持批量选择', 2],
            ['todo', '骨架屏', 4],
            ['note', '每页数量', 17],
            ['note', '已选数量', 20],
            ['fixme', '依赖后端字段，先写死', 29]
        ]);
    });

    test('A trailing comment is not attributed to the next declaration', () => {
        const source = [
            'const first = 1; // 行尾说明',
            'function second() {}'
        ].join('\n');
        const result = analyze(source, 'trailing.js');
        assert.strictEqual(node(result, 'function', 'second').doc, undefined);
        assert.ok(result.comments.some(item => item.kind === 'note'
            && item.text === '行尾说明' && item.line === 1));
    });

    test('Summary falls back to structure facts when the file has no author comment', () => {
        const script = analyze("export function plain() { return 1; }", 'plain.js');
        assert.strictEqual(script.doc, null);
        assert.deepStrictEqual(script.comments, []);
        assert.strictEqual(script.guide.summary?.origin, 'structure');
        assert.strictEqual(script.guide.summary?.confidence, 'fact');

        const component = analyze("<script>export default { name: 'Card' };</script>", 'Card.vue');
        assert.strictEqual(component.doc, null);
        assert.strictEqual(component.guide.summary?.origin, 'structure');
        assert.ok(component.guide.summary?.text.includes('Card'));
    });

    test('Vue Options API exposes props, emits, slots, injections and state flow', () => {
        const source = [
            '<template>',
            '  <div>',
            '    <slot name="header">标题</slot>',
            '    <slot :item="count" />',
            '    <button @click="submit">提交</button>',
            '  </div>',
            '</template>',
            '<script>',
            'export default {',
            "  name: 'Counter',",
            '  props: {',
            '    id: { type: String, required: true },',
            '    size: { type: [Number, String], default: 10 },',
            '    mode: { type: String, validator: (v) => v.length > 0 }',
            '  },',
            "  emits: ['submit', 'close'],",
            "  provide() { return { theme: 'dark' }; },",
            "  inject: ['store'],",
            '  data() { return { count: 0 }; },',
            '  computed: { double() { return this.count * 2; } },',
            "  watch: { count: 'onCount' },",
            '  methods: {',
            "    submit() { this.count++; this.$emit('submit', this.count); },",
            '    onCount() {}',
            '  }',
            '};',
            '</script>'
        ].join('\n');
        const result = analyze(source, 'Counter.vue');
        assert.deepStrictEqual(result.errors, []);

        const id = result.contract.props.find(item => item.name === 'id')!;
        assert.strictEqual(id.type, 'String');
        assert.strictEqual(id.required, true);
        assert.strictEqual(id.defaultText, null);
        assert.strictEqual(id.hasValidator, false);
        assert.strictEqual(id.source, 'object');
        const size = result.contract.props.find(item => item.name === 'size')!;
        assert.strictEqual(size.type, 'Number | String');
        assert.strictEqual(size.defaultText, '10');
        assert.strictEqual(size.required, false);
        const mode = result.contract.props.find(item => item.name === 'mode')!;
        assert.strictEqual(mode.hasValidator, true);

        assert.deepStrictEqual(result.contract.emits.map(item => item.name), ['submit', 'close']);
        const submitEmit = result.contract.emits.find(item => item.name === 'submit')!;
        assert.strictEqual(submitEmit.declared, true);
        assert.strictEqual(submitEmit.declarationLine, 16);
        assert.deepStrictEqual(submitEmit.triggers.map(item => [item.ownerName, item.line]),
            [['submit', 23]]);
        assert.deepStrictEqual(
            result.contract.emits.find(item => item.name === 'close')!.triggers, []);

        assert.deepStrictEqual(result.contract.slots.map(item => [item.name, item.line, item.scoped]), [
            ['header', 3, false],
            ['default', 4, true]
        ]);
        assert.deepStrictEqual(
            result.contract.injections.map(item => [item.key, item.kind, item.certainty]),
            [['theme', 'provide', 'certain'], ['store', 'inject', 'certain']]);

        const countFlow = result.contract.flows.find(item => item.name === 'count')!;
        const submitMethod = node(result, 'method', 'submit');
        const doubleComputed = node(result, 'computed', 'double');
        const countWatch = node(result, 'watch', 'count');
        assert.ok(countFlow.writes.some(item => item.id === submitMethod.id && item.line === 23));
        assert.ok(countFlow.reads.some(item => item.id === submitMethod.id));
        assert.ok(countFlow.reads.some(item => item.id === doubleComputed.id && item.line === 20));
        assert.ok(countFlow.watches.some(item => item.id === countWatch.id));
        assert.deepStrictEqual(countFlow.templateLines, [4]);
    });

    test('Script setup macros expose typed props, emits, model and injections', () => {
        const source = [
            '<script setup lang="ts">',
            "import { ref, watch, provide, inject } from 'vue';",
            'interface Props { label: string; count?: number }',
            'const props = withDefaults(defineProps<Props>(), { count: 3 });',
            "const emit = defineEmits<{ (e: 'change', value: number): void }>();",
            "const title = defineModel<string>('title');",
            'const total = ref(0);',
            "provide('theme', 'dark');",
            "const store = inject('store');",
            'watch(total, () => { total.value = 1; });',
            "function bump() { total.value++; emit('change', total.value); }",
            '</script>'
        ].join('\n');
        const result = analyze(source, 'Setup.vue');
        assert.deepStrictEqual(result.errors, []);

        const label = result.contract.props.find(item => item.name === 'label')!;
        assert.strictEqual(label.type, 'string');
        assert.strictEqual(label.required, true);
        assert.strictEqual(label.source, 'type');
        const count = result.contract.props.find(item => item.name === 'count')!;
        assert.strictEqual(count.required, false);
        assert.strictEqual(count.defaultText, '3');
        assert.ok(result.contract.props.some(item => item.name === 'title'));

        const change = result.contract.emits.find(item => item.name === 'change')!;
        assert.strictEqual(change.declared, true);
        assert.strictEqual(change.declarationLine, 5);
        assert.deepStrictEqual(change.triggers.map(item => [item.ownerName, item.line]),
            [['bump', 11]]);
        assert.ok(result.contract.emits.some(item => item.name === 'update:title'));

        const totalFlow = result.contract.flows.find(item => item.name === 'total')!;
        const bump = node(result, 'function', 'bump');
        const watchNode = node(result, 'watch', 'total');
        assert.ok(totalFlow.writes.some(item => item.id === bump.id && item.line === 11));
        assert.ok(totalFlow.reads.some(item => item.id === bump.id));
        assert.ok(totalFlow.watches.some(item => item.id === watchNode.id));

        assert.deepStrictEqual(result.contract.injections.map(item => [item.key, item.kind]), [
            ['theme', 'provide'], ['store', 'inject']
        ]);
    });

    test('Timeline and function cards expose order, signature and impact surface', () => {
        const source = [
            '<script>',
            'export default {',
            "  name: 'Board',",
            '  data() { return { items: [], loading: false }; },',
            '  computed: { total() { return this.items.length; } },',
            "  watch: { items: 'reload' },",
            '  methods: {',
            '    async reload() {',
            '      try {',
            '        this.loading = true;',
            '        await this.fetch();',
            '        this.items = [];',
            '        return this.items;',
            '      } catch (error) { this.loading = false; }',
            '    },',
            '    fetch() {}',
            '  }',
            '};',
            '</script>'
        ].join('\n');
        const result = analyze(source, 'Board.vue');
        assert.deepStrictEqual(result.errors, []);

        assert.deepStrictEqual(result.timeline.map(step => [step.name, step.kind, step.line]), [
            ['items', 'state', 4],
            ['loading', 'state', 4],
            ['total', 'computed', 5],
            ['items', 'watch', 6]
        ]);

        const reload = result.functions.find(item => item.name === 'reload')!;
        assert.strictEqual(reload.signature, 'async reload()');
        assert.strictEqual(reload.line, 8);
        assert.strictEqual(reload.isAsync, true);
        assert.strictEqual(reload.hasReturn, true);
        assert.strictEqual(reload.errorHandling, true);
        assert.deepStrictEqual(reload.params, []);
        assert.deepStrictEqual(reload.callers, []);
        assert.deepStrictEqual(reload.callees.map(ref => [ref.name, ref.line]), [['fetch', 11]]);
        assert.deepStrictEqual(reload.writes.map(ref => [ref.name, ref.line]),
            [['loading', 10], ['items', 12]]);

        const fetch = result.functions.find(item => item.name === 'fetch')!;
        assert.strictEqual(fetch.signature, 'fetch()');
        assert.strictEqual(fetch.hasReturn, false);
        assert.strictEqual(fetch.errorHandling, false);
        assert.deepStrictEqual(fetch.callers.map(ref => [ref.name, ref.line]), [['reload', 11]]);

        const total = result.functions.find(item => item.name === 'total')!;
        assert.strictEqual(total.hasReturn, true);
        assert.strictEqual(total.isAsync, false);

        const js = analyze('export const pick = (a, b) => a + b;', 'pick.js');
        assert.deepStrictEqual(js.timeline, []);
        const pick = js.functions.find(item => item.name === 'pick')!;
        assert.strictEqual(pick.signature, 'pick(a, b)');
        assert.strictEqual(pick.hasReturn, true);
        assert.strictEqual(pick.isAsync, false);
    });

    test('Bundled CLI and core return the same JSON for one snapshot', function () {
        this.timeout(15_000);
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'code-nav-m1-'));
        try {
            const file = path.join(directory, 'sample.vue');
            const source = [
                '<template><button @click="save" /></template>',
                '<script setup>',
                'function save() { return 1; }',
                '</script>'
            ].join('\n');
            fs.writeFileSync(file, source, 'utf8');
            const cli = path.resolve(__dirname, '../../../dist/codeNavCli.js');
            const output = execFileSync(process.execPath, [cli, file], { encoding: 'utf8' });
            assert.deepStrictEqual(JSON.parse(output), JSON.parse(JSON.stringify(analyze(source, file))));

            const broken = path.join(directory, 'broken.js');
            fs.writeFileSync(broken, 'export function broken(', 'utf8');
            const failed = spawnSync(process.execPath, [cli, broken], { encoding: 'utf8' });
            assert.strictEqual(failed.status, 2);
            assert.ok(JSON.parse(failed.stdout).errors.length > 0);
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
});
