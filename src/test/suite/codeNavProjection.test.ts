import * as assert from 'assert';
import { analyze } from '../../codeNavCore';
import { PAGE_SIZE, projectResult, sectionPage, templatePage } from '../../codeNavProjection';
import { NavNode, TemplateNode } from '../../codeNavTypes';

suite('Code navigation projection', () => {
    test('bounds preview payload but keeps every declaration reachable by paging', () => {
        const result = analyze('export function first() {}', 'large.js');
        const example = result.nodes.find(item => item.kind === 'function')!;
        const declarations: NavNode[] = Array.from({ length: 10_000 }, (_, index) => ({
            ...example, id: `function:${index}`, name: `f${index}`
        }));
        result.nodes = declarations;
        result.script.declarations = declarations.map(item => item.id);
        result.guide.entries = [declarations[0].id];
        const projected = projectResult(result);
        assert.strictEqual(projected.pagination.sections.declarations, 10_000);
        assert.ok(projected.nodes.length <= 100);
        assert.strictEqual(projected.script.declarations.length, PAGE_SIZE);
        assert.deepStrictEqual(sectionPage(result, 'declarations', 9950)?.map(item => item.name),
            declarations.slice(9950).map(item => item.name));
        result.script.exports = [declarations[3].id, declarations[1].id];
        assert.deepStrictEqual(sectionPage(result, 'exports', 0)?.map(item => item.name),
            ['f3', 'f1']);
        assert.strictEqual(sectionPage(result, 'declarations', 10_000), undefined);
        assert.strictEqual(sectionPage(result, 'declarations', -1), undefined);
    });

    test('loads template roots and child subtrees without shipping descendants in preview', () => {
        const result = analyze('<template><div /></template>', 'large.vue');
        const example = result.template!.tree[0];
        const roots: TemplateNode[] = Array.from({ length: 80 }, (_, index) => ({
            ...example, id: `template:${index}`, tag: `item-${index}`,
            children: index === 0 ? [{ ...example, id: 'nested', tag: 'nested', children: [] }] : []
        }));
        result.template = { rootEl: 'item-0', tree: roots };
        const projected = projectResult(result);
        assert.strictEqual(projected.pagination.templateCount, 80);
        assert.strictEqual(projected.template?.tree.length, PAGE_SIZE);
        assert.deepStrictEqual(projected.template?.tree[0].children, []);
        assert.strictEqual(projected.template?.tree[0].hasChildren, true);
        assert.strictEqual(templatePage(result, null, 50)?.items[0].tag, 'item-50');
        assert.strictEqual(templatePage(result, 'template:0', 0)?.items[0].tag, 'nested');
        assert.strictEqual(templatePage(result, 'missing', 0), undefined);
    });
});
