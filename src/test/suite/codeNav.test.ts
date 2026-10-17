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
