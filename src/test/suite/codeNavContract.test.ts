import * as assert from 'assert';
import {
    checkUsage, findTagUsages, importBindings, kebabCase, parseTagAttributes, tagCandidatesFor, tagsFromFile
} from '../../codeNavContract';

suite('Code navigation contract check', () => {
    test('derives tag names from a binding and from the file name', () => {
        assert.strictEqual(kebabCase('FooBar'), 'foo-bar');
        assert.strictEqual(kebabCase('fooBar'), 'foo-bar');
        assert.deepStrictEqual(tagCandidatesFor('FooBar'), ['FooBar', 'foo-bar']);
        assert.deepStrictEqual(tagCandidatesFor('foo-bar'), ['foo-bar']);
        assert.deepStrictEqual(tagsFromFile('src/components/FooBar.vue'), ['FooBar', 'foo-bar']);
        // index 文件不能拿文件名当标签名，只能靠父组件的绑定名
        assert.deepStrictEqual(tagsFromFile('src/components/index.vue'), []);
    });

    test('extracts local bindings from import and export statements', () => {
        assert.deepStrictEqual(importBindings("import Foo from './Foo.vue';", './Foo.vue'), ['Foo']);
        assert.deepStrictEqual(
            importBindings("import Foo, { Bar, Baz as Qux } from './Foo.vue';", './Foo.vue'),
            ['Bar', 'Qux', 'Foo']);
        assert.deepStrictEqual(importBindings("import * as NS from './Foo.vue';", './Foo.vue'), ['NS']);
        assert.deepStrictEqual(importBindings("export { default as Re } from './Foo.vue';", './Foo.vue'), ['Re']);
        // `export { default } from` 里的 default 不是标签名
        assert.deepStrictEqual(importBindings("export { default } from './Foo.vue';", './Foo.vue'), []);
        assert.deepStrictEqual(importBindings("import './Foo.vue';", './Foo.vue'), []);
        assert.deepStrictEqual(importBindings("import type { P } from './Foo.vue';", './Foo.vue'), ['P']);
    });

    test('finds tag usages with attribute text and source line', () => {
        const source = [
            '<template>',
            '  <div>',
            '    <FooBar :title="a > b" class="x" @go="run" />',
            '    </FooBar>',
            '  </div>',
            '</template>'
        ].join('\n');
        const usages = findTagUsages(source, ['FooBar', 'foo-bar']);
        assert.strictEqual(usages.length, 1);
        assert.strictEqual(usages[0].tag, 'FooBar');
        assert.strictEqual(usages[0].line, 3);
        assert.ok(usages[0].attrs.includes(':title="a > b"'));
        // 闭合标签与更长的标签名都不算使用点
        assert.strictEqual(findTagUsages(source, ['Foo']).length, 0);
    });

    test('splits attributes into props, events, directives and spread', () => {
        const { attributes, spread } = parseTagAttributes(
            ':title="t" v-bind:foo.sync="f" bar="1" @go="on" v-on:close="off" v-model="m" class="c" data-x="1" v-bind="rest"');
        assert.strictEqual(spread, true);
        const byName = new Map(attributes.map(item => [`${item.kind}:${item.name}`, item]));
        assert.strictEqual(byName.get('prop:title')?.dynamic, true);
        assert.strictEqual(byName.get('prop:foo')?.dynamic, true);
        assert.strictEqual(byName.get('prop:bar')?.dynamic, false);
        assert.strictEqual(byName.get('event:go')?.dynamic, false);
        assert.strictEqual(byName.get('event:close')?.dynamic, false);
        assert.strictEqual(byName.get('special:v-model')?.name, 'v-model');
        assert.strictEqual(byName.get('special:class')?.kind, 'special');
        assert.strictEqual(byName.get('special:data-x')?.kind, 'special');
    });

    test('reports missing required props and undeclared attributes as candidates', () => {
        const usage = findTagUsages(
            '<FooBar :known="1" unknown-prop="1" @missing="run" />', ['FooBar'])[0];
        const issues = checkUsage(usage, [{ name: 'known', required: false }, { name: 'count', required: true }],
            ['submit']);
        const byKind = new Map(issues.map(item => [item.kind, item]));
        assert.strictEqual(byKind.get('missing-required')?.certainty, 'certain');
        assert.ok(byKind.get('missing-required')?.detail.includes('count'));
        assert.strictEqual(byKind.get('unknown-prop')?.certainty, 'unresolved');
        assert.strictEqual(byKind.get('unknown-event')?.certainty, 'unresolved');
        assert.strictEqual(issues.length, 3);
    });

    test('passes a clean usage and lets v-bind spread suppress required checks', () => {
        const clean = findTagUsages('<FooBar :count="1" @submit="run" />', ['FooBar'])[0];
        assert.deepStrictEqual(
            checkUsage(clean, [{ name: 'count', required: true }], ['submit']), []);
        const spread = findTagUsages('<FooBar v-bind="rest" />', ['FooBar'])[0];
        assert.deepStrictEqual(checkUsage(spread, [{ name: 'count', required: true }], []), []);
    });
});
