import { parse as parseJavaScript } from '@babel/parser';
import { parse as parseVue } from '@vue/compiler-sfc';

export interface ProbeResult {
    fileType: 'vue' | 'js';
    hasTemplate: boolean;
    scriptBlocks: number;
    topLevelDeclarations: number;
    errors: number;
}

// M0 only: exercise both parsers through the shared Node and extension bundle.
export function probeParse(source: string, fileName: string): ProbeResult {
    const vue = fileName.toLowerCase().endsWith('.vue');
    const descriptor = vue ? parseVue(source, { filename: fileName }) : undefined;
    const scripts = descriptor
        ? [descriptor.descriptor.script, descriptor.descriptor.scriptSetup].filter(
            (block): block is NonNullable<typeof block> => Boolean(block)
        )
        : [{ content: source, lang: 'js' }];

    let topLevelDeclarations = 0;
    for (const script of scripts) {
        const ast = parseJavaScript(script.content, {
            sourceType: 'unambiguous',
            plugins: script.lang === 'ts' || script.lang === 'tsx' ? ['typescript'] : ['jsx']
        });
        topLevelDeclarations += ast.program.body.length;
    }

    return {
        fileType: vue ? 'vue' : 'js',
        hasTemplate: Boolean(descriptor?.descriptor.template),
        scriptBlocks: scripts.length,
        topLevelDeclarations,
        errors: descriptor?.errors.length ?? 0
    };
}
