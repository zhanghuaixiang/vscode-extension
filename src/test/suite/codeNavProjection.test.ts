import * as assert from 'assert';
import { analyze } from '../../codeNavCore';
import { PAGE_SIZE, matchNodes, projectResult, sectionPage, templatePage } from '../../codeNavProjection';
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

    test('bounds author comment previews but keeps the full count', () => {
        const result = analyze('export const value = 1;', 'notes.js');
        const example = { kind: 'todo' as const, text: '待办', line: 1, block: 'script' as const };
        result.comments = Array.from({ length: 60 }, (_, index) => ({
            ...example, id: `comment:${index}`
        }));
        const projected = projectResult(result);
        assert.strictEqual(projected.comments.length, 40);
        assert.strictEqual(projected.pagination.commentCount, 60);
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

    test('keeps contract nodes reachable and reports contract counts', () => {
        const source = [
            '<template><button @click="submit">{{ count }}</button><slot :item="count" /></template>',
            '<script>',
            'export default {',
            "  name: 'Counter',",
            "  props: { id: { type: String, required: true } },",
            "  emits: ['submit'],",
            '  data() { return { count: 0 }; },',
            '  methods: { submit() { this.count++; this.$emit("submit"); } }',
            '};',
            '</script>'
        ].join('\n');
        const result = analyze(source, 'Counter.vue');
        const projected = projectResult(result);
        assert.strictEqual(projected.pagination.propCount, result.contract.props.length);
        assert.strictEqual(projected.pagination.emitCount, result.contract.emits.length);
        assert.strictEqual(projected.pagination.slotCount, 1);
        assert.strictEqual(projected.pagination.flowCount, result.contract.flows.length);
        assert.ok(projected.pagination.flowCount >= 2);
        const ids = new Set(projected.nodes.map(item => item.id));
        for (const prop of result.contract.props) { assert.ok(ids.has(prop.id), `missing ${prop.name}`); }
        for (const slot of result.contract.slots) { assert.ok(ids.has(slot.id), 'missing slot'); }
        for (const flow of result.contract.flows) {
            assert.ok(ids.has(flow.id), `missing flow ${flow.name}`);
            for (const ref of [...flow.reads, ...flow.writes, ...flow.watches]) {
                assert.ok(ids.has(ref.id), `missing flow ref ${flow.name}`);
            }
        }
    });

    test('bounds the timeline and function cards while keeping full counts', () => {
        const source = [
            '<script>',
            'export default {',
            "  name: 'Board',",
            '  data() { return { items: [] }; },',
            "  watch: { items: 'reload' },",
            '  methods: {',
            '    async reload() { try { await this.fetch(); return this.items; } catch (e) {} },',
            '    fetch() {}',
            '  }',
            '};',
            '</script>'
        ].join('\n');
        const result = analyze(source, 'Board.vue');
        const projected = projectResult(result);
        assert.strictEqual(projected.pagination.timelineCount, result.timeline.length);
        assert.strictEqual(projected.pagination.functionCount, result.functions.length);
        assert.ok(projected.pagination.functionCount >= 2);
        assert.ok(projected.timeline.length <= 60);
        assert.ok(projected.functions.length <= 60);
        const ids = new Set(projected.nodes.map(item => item.id));
        for (const step of result.timeline) {
            if (step.id) { assert.ok(ids.has(step.id), `missing timeline ${step.name}`); }
        }
    });

    test('deduplicates relation edges reachable from both focus and diffusion', () => {
        const result = analyze('export function first() {}', 'dup.js');
        const entry = result.nodes.find(item => item.id === result.guide.entries[0])!;
        const fn = result.nodes.find(item => item.kind === 'function')!;
        result.paths = [
            { from: entry.id, to: fn.id, type: 'exports', certainty: 'certain', evidence: fn.range },
            { from: fn.id, to: entry.id, type: 'calls', certainty: 'certain', evidence: entry.range }
        ];
        const projected = projectResult(result, fn.id);
        assert.deepStrictEqual(projected.paths.map(edge => edge.index), [0, 1]);
    });

    test('ranks panel search hits by exact, prefix then substring, and caps the result', () => {
        const result = analyze('export function save() {}', 'search.js');
        const example = result.nodes[0];
        const at = (line: number) => ({ startLine: line, startColumn: 0, endLine: line, endColumn: 1 });
        const nodes: NavNode[] = [
            { ...example, id: 'n1', name: 'loadUser', range: at(30) },
            { ...example, id: 'n2', name: 'user', range: at(8) },
            { ...example, id: 'n3', name: 'user', range: at(2) },
            { ...example, id: 'n4', name: 'fetchUserList', range: at(5) },
            { ...example, id: 'n5', name: '', range: at(1) }
        ];
        // 同名优先于包含，同档按行号升序；空名字的节点不参与。
        const found = matchNodes(nodes, 'User', 2);
        assert.strictEqual(found.total, 4);
        assert.deepStrictEqual(found.matches.map(item => item.id), ['n3', 'n2']);
        assert.deepStrictEqual(matchNodes(nodes, 'User', 10).matches.map(item => item.id),
            ['n3', 'n2', 'n4', 'n1']);
        // 前后空格会被裁掉，匹配本身大小写不敏感。
        assert.strictEqual(matchNodes(nodes, ' loaduser ', 10).matches[0].id, 'n1');
        assert.deepStrictEqual(matchNodes(nodes, 'u', 10), { total: 0, matches: [] });
        assert.deepStrictEqual(matchNodes(nodes, 'missing', 10), { total: 0, matches: [] });
    });
});
