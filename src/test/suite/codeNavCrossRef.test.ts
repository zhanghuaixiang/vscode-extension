import * as assert from 'assert';
import * as path from 'path';
import {
    aliasTarget, parseAliasRules, parseImportSpecifiers, parseJsonc, resolveSpecifier, sameFile,
    searchPatternsFor, snippetOf
} from '../../codeNavCrossRef';

const ROOT = process.platform === 'win32' ? 'C:\\ws' : '/ws';

suite('Code navigation cross file evidence', () => {
    test('picks literal fragments that could reference the target file', () => {
        const patterns = searchPatternsFor(path.join(ROOT, 'src', 'components', 'Foo.vue'));
        assert.ok(patterns.includes('/Foo.vue'));
        assert.ok(patterns.includes("/Foo'"));
        assert.ok(patterns.includes('/Foo"'));
        // index 文件被引用时写的是目录名，而不是 index
        const index = searchPatternsFor(path.join(ROOT, 'src', 'utils', 'index.ts'));
        assert.ok(index.includes('/index.ts'));
        assert.ok(index.includes("/utils'"));
        assert.ok(index.includes('/utils"'));
        assert.ok(!index.includes('/index.tsx'));
    });

    test('extracts import-like specifiers with their source line', () => {
        const source = [
            "import Foo from './Foo.vue';",
            "import { helper } from \"@/utils/helper\";",
            "export { other } from './other.js';",
            "import './side.css';",
            "const legacy = require('./legacy.js');",
            "const lazy = () => import('./lazy.js');"
        ].join('\n');
        const found = parseImportSpecifiers(source);
        assert.deepStrictEqual(found.map(item => item.specifier), [
            './Foo.vue', '@/utils/helper', './other.js', './side.css', './legacy.js', './lazy.js'
        ]);
        assert.deepStrictEqual(found.map(item => item.line), [1, 2, 3, 4, 5, 6]);
    });

    test('does not mistake ordinary string literals for imports', () => {
        const found = parseImportSpecifiers("const label = './Foo.vue';\n// import X from './Bar.vue'\n");
        // 命中注释里的 import 只是候选，最终还要由 resolveSpecifier 校验，这里不额外过滤
        assert.deepStrictEqual(found.map(item => item.specifier), ['./Bar.vue']);
    });

    test('resolves alias prefixes with and without wildcards', () => {
        const rules = [
            { prefix: '@/components/*', target: path.join(ROOT, 'src', 'components', '*') },
            { prefix: 'vue', target: path.join(ROOT, 'node_modules', 'vue', 'index.js') }
        ];
        assert.strictEqual(aliasTarget('@/components/Foo.vue', rules),
            path.join(ROOT, 'src', 'components', 'Foo.vue'));
        assert.strictEqual(aliasTarget('vue', rules), rules[1].target);
        assert.strictEqual(aliasTarget('@/other/Foo.vue', rules), undefined);
        assert.strictEqual(aliasTarget('@/components', rules), undefined);
        assert.strictEqual(aliasTarget('./relative', rules), undefined);
    });

    test('resolves a specifier back to a real file, including index fallbacks', () => {
        const importer = path.join(ROOT, 'src', 'views', 'Home.vue');
        const resolved = resolveSpecifier('./Foo.vue', importer, [], file => file.endsWith('Foo.vue'));
        assert.ok(resolved && resolved.endsWith('Foo.vue'));
        // 省略扩展名时按扩展名与目录 index 依次兜底
        const indexed = resolveSpecifier('./utils', importer, [], file => file.endsWith('index.ts'));
        assert.ok(indexed && /utils[\\/]index\.ts$/.test(indexed));
        // 协议、裸包名与未知别名都不该被当成工作区文件
        assert.strictEqual(resolveSpecifier('node:fs', importer, [], () => true), undefined);
        assert.strictEqual(resolveSpecifier('lodash', importer, [], () => true), undefined);
        assert.strictEqual(resolveSpecifier('@/x', importer, [], () => true), undefined);
    });

    test('compares files case insensitively on Windows only', () => {
        const upper = process.platform === 'win32' ? 'C:\\Ws\\A.vue' : '/ws/A.vue';
        const lower = process.platform === 'win32' ? 'c:\\ws\\a.vue' : '/ws/a.vue';
        assert.strictEqual(sameFile(upper, lower), process.platform === 'win32');
        assert.strictEqual(sameFile(path.join(ROOT, 'a.vue'), path.join(ROOT, 'b.vue')), false);
    });

    test('parses JSONC without touching URLs inside strings', () => {
        const parsed = parseJsonc(`{
            // 行注释
            "compilerOptions": {
                "baseUrl": "src",
                "paths": { "@/*": ["*"], },
            },
            /* 块注释 */
            "remote": "https://example.com/x"
        }`);
        assert.ok(parsed);
        assert.strictEqual(parsed!.remote, 'https://example.com/x');
        assert.deepStrictEqual((parsed!.compilerOptions as { paths: Record<string, string[]> }).paths,
            { '@/*': ['*'] });
        assert.strictEqual(parseJsonc('{ 不是合法 JSON'), null);
    });

    test('collects alias rules from tsconfig paths and bundler shorthand', () => {
        const files: Record<string, string> = {
            [path.join(ROOT, 'tsconfig.json')]: JSON.stringify({
                compilerOptions: { baseUrl: 'src', paths: { '@/*': ['*'], '~/*': ['components/*'] } }
            })
        };
        const read = (file: string): string | null => files[file] ?? null;
        const rules = parseAliasRules(ROOT, read);
        assert.strictEqual(aliasTarget('@/utils/a', rules),
            path.join(ROOT, 'src', 'utils', 'a'));
        assert.strictEqual(aliasTarget('~/button', rules),
            path.join(ROOT, 'src', 'components', 'button'));
        // baseUrl 本身也允许以根路径形式引用
        assert.strictEqual(aliasTarget('src/utils/b', rules), path.join(ROOT, 'src', 'utils', 'b'));
        assert.deepStrictEqual(parseAliasRules(ROOT, () => null), []);
    });

    test('collects shorthand aliases from bundler config files', () => {
        const files: Record<string, string> = {
            [path.join(ROOT, 'vue.config.js')]:
                "module.exports = { configureWebpack: { resolve: { alias: {\n"
                + "  '@': path.resolve(__dirname, 'src'),\n  '~': 'lib'\n} } } };"
        };
        const rules = parseAliasRules(ROOT, file => files[file] ?? null);
        assert.strictEqual(aliasTarget('@/api/x', rules), path.join(ROOT, 'src', 'api', 'x'));
        assert.strictEqual(aliasTarget('~/x', rules), path.join(ROOT, 'lib', 'x'));
    });

    test('collapses whitespace for candidate snippets', () => {
        assert.strictEqual(snippetOf("  import Foo from './Foo.vue';   \n"), "import Foo from './Foo.vue';");
        assert.strictEqual(snippetOf('x'.repeat(200)).length, 80);
    });
});
