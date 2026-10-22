import * as assert from 'assert';
import ReadI18n from '../../readI18n';

/** 取内部实现做单测：只校验对象字面量的定位结果 */
const extract = (raw: string): string | null => (ReadI18n as unknown as {
    extractObjectSource(source: string): string | null;
}).extractObjectSource(raw);

const LF = '\n';
const CR = '\r';

suite('readI18n', () => {
    test('extracts the object exported directly', () => {
        assert.strictEqual(extract(`export default {${LF}  a: 'b'${LF}};${LF}`), `{${LF}  a: 'b'${LF}}`);
    });

    test('extracts the object assigned to a variable before export', () => {
        const raw = `const lang = {${LF}  a: 'b'${LF}};${LF}export default lang;${LF}`;
        assert.strictEqual(extract(raw), `{${LF}  a: 'b'${LF}}`);
    });

    test('extracts the object exported by module.exports', () => {
        assert.strictEqual(extract(`module.exports = {${LF}  a: 'b'${LF}};${LF}`), `{${LF}  a: 'b'${LF}}`);
    });

    test('extracts the outermost object when keys are nested', () => {
        assert.strictEqual(extract(`export default {${LF}  a: { b: 'c' }${LF}};${LF}`), `{${LF}  a: { b: 'c' }${LF}}`);
    });

    test('keeps the object when a comment inside it uses CR-only line endings', () => {
        const raw = `export default {${CR}  a: 'b', // 说明${CR}  c: 'd'${CR}};`;
        assert.strictEqual(extract(raw), `{${CR}  a: 'b', // 说明${CR}  c: 'd'${CR}}`);
    });

    test('ignores braces and comment marks inside comments and strings', () => {
        const raw = `import { x } from 'y';${LF}export default /* { note */ {${LF}  a: 'b // x',${LF}  c: '{ }'${LF}};${LF}`;
        assert.strictEqual(extract(raw), `{${LF}  a: 'b // x',${LF}  c: '{ }'${LF}}`);
    });

    test('falls back to the largest object when import braces come first', () => {
        const raw = `import { x } from 'y';${LF}const data = {${LF}  a: 'b'${LF}};${LF}`;
        assert.strictEqual(extract(raw), `{${LF}  a: 'b'${LF}}`);
    });

    test('strips img tags from texts', () => {
        assert.strictEqual(extract(`export default {${LF}  a: 'hi <img src="x"/> end'${LF}};${LF}`), `{${LF}  a: 'hi  end'${LF}}`);
    });

    test('returns null when the file has no object literal', () => {
        assert.strictEqual(extract(`export default merge(a, b);${LF}`), null);
    });
});
