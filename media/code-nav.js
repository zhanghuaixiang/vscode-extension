(() => {
    'use strict';
    const vscode = acquireVsCodeApi();
    const root = document.getElementById('app');
    let state = { status: 'unsupported', message: '打开 .vue、.js 或 .ts 文件开始阅读' };
    let tab = 'guide';
    // AI 解读只存在于面板内：按 scope（'file' 或节点 id）分别记录结果、生成中与失败。
    let aiResult = new Map();
    let aiPending = new Set();
    let aiError = new Map();

    function el(tag, className, text) {
        const element = document.createElement(tag);
        if (className) element.className = className;
        if (text !== undefined) element.textContent = String(text);
        return element;
    }

    function button(label, action, value, className) {
        const element = el('button', className || 'nav-link', label);
        element.type = 'button';
        element.dataset.action = action;
        if (value !== undefined) element.dataset.value = value;
        return element;
    }

    function docBlock(node) {
        if (!node.doc) return null;
        const block = el('div', 'doc-block');
        if (node.doc.text) block.append(el('p', 'doc-text', node.doc.text));
        if (node.doc.tags?.length) {
            const tags = el('div', 'doc-tags');
            for (const item of node.doc.tags) {
                tags.append(el('span', `doc-tag tag-${item.tag}`,
                    `@${item.tag}${item.text ? ` ${item.text}` : ''}`));
            }
            block.append(tags);
        }
        return block.children.length ? block : null;
    }

    function textLine(node, label) {
        const entry = el('div', 'node-entry');
        const doc = docBlock(node);
        if (doc) entry.append(doc);
        const row = el('div', 'node-row');
        row.append(button(label || node.name, 'reveal', node.id));
        row.append(el('span', 'line-mark', `L${node.range.startLine}`));
        entry.append(row);
        return entry;
    }

    const noteLabels = { todo: 'TODO', fixme: 'FIXME', hack: 'HACK', note: '备注' };

    function renderNotes(result, limit) {
        const notes = result.comments ?? [];
        if (!notes.length) return null;
        const total = result.pagination?.commentCount ?? notes.length;
        const list = el('div', 'note-list');
        for (const note of notes.slice(0, limit)) {
            const row = el('div', 'note-row');
            row.append(el('span', `note-kind kind-${note.kind}`, noteLabels[note.kind] || note.kind));
            row.append(button(note.text, 'reveal', note.id, 'note-text'));
            row.append(el('span', 'line-mark', `L${note.line}`));
            list.append(row);
        }
        if (total > limit) {
            list.append(el('p', 'overflow-note', `还有 ${total - limit} 条备注，可切换到完整结构查看。`));
        }
        return list;
    }

    function renderProps(props, nodes) {
        const list = el('div', 'contract-list');
        for (const prop of props) {
            const item = nodes.get(prop.id);
            const row = el('div', 'contract-row');
            const head = el('div', 'node-row');
            head.append(button(prop.name, 'reveal', prop.id, 'contract-name'));
            if (prop.type) head.append(el('span', 'contract-type', prop.type));
            if (prop.required) head.append(el('span', 'contract-flag required', '必填'));
            if (prop.hasValidator) head.append(el('span', 'contract-flag', 'validator'));
            head.append(el('span', 'line-mark', item ? `L${item.range.startLine}` : ''));
            row.append(head);
            if (prop.defaultText) {
                row.append(el('div', 'contract-note', `默认值 ${prop.defaultText}`));
            }
            list.append(row);
        }
        return list;
    }

    function renderEmits(emits, nodes) {
        const list = el('div', 'contract-list');
        for (const item of emits) {
            const row = el('div', 'contract-row');
            const head = el('div', 'node-row');
            head.append(el('span', 'contract-name', `@${item.name}`));
            head.append(el('span', `contract-flag ${item.declared ? 'required' : ''}`,
                item.declared ? '已在 emits 声明' : '未在 emits 声明'));
            head.append(el('span', 'line-mark', item.declarationLine ? `L${item.declarationLine}` : ''));
            row.append(head);
            for (const trigger of item.triggers) {
                const line = el('div', 'contract-trigger');
                line.append(button(trigger.ownerName, 'reveal', trigger.ownerId));
                line.append(el('span', 'line-mark', `L${trigger.line}`));
                row.append(line);
            }
            if (!item.triggers.length) {
                row.append(el('div', 'contract-note', '本文件内未见触发点。'));
            }
            list.append(row);
        }
        return list;
    }

    function renderSlots(slots) {
        const list = el('div', 'contract-list');
        for (const slot of slots) {
            const row = el('div', 'node-row');
            row.append(button(slot.name === 'default' ? '<slot>' : `<slot name="${slot.name}">`,
                'reveal', slot.id, 'contract-name'));
            if (slot.scoped) row.append(el('span', 'contract-flag', '作用域插槽'));
            row.append(el('span', 'line-mark', `L${slot.line}`));
            list.append(row);
        }
        return list;
    }

    function renderInjections(injections) {
        const list = el('div', 'contract-list');
        for (const item of injections) {
            const row = el('div', 'node-row');
            row.append(el('span', 'contract-kind', item.kind));
            row.append(el('span', 'contract-name', item.key));
            if (item.certainty === 'unresolved') row.append(el('span', 'contract-flag', '未确认'));
            const jump = button(`L${item.line}`, 'revealLine', undefined, 'line-link');
            jump.dataset.line = String(item.line);
            row.append(jump);
            list.append(row);
        }
        return list;
    }

    function flowRefs(refs, nodes, label) {
        if (!refs.length) return null;
        const part = el('div', 'flow-part');
        part.append(el('span', 'flow-label', label));
        for (const ref of refs) {
            const item = nodes.get(ref.id);
            part.append(button(item ? item.name : ref.id, 'reveal', ref.id, 'flow-ref'));
            part.append(el('span', 'flow-line', `L${ref.line}`));
        }
        return part;
    }

    function renderFlows(flows, nodes) {
        const list = el('div', 'flow-list');
        for (const flow of flows) {
            const item = nodes.get(flow.id);
            const row = el('div', 'flow-row');
            const head = el('div', 'node-row');
            head.append(button(flow.name, 'reveal', flow.id, 'flow-name'));
            if (item) head.append(el('span', 'contract-kind', item.kind));
            head.append(el('span', 'line-mark', item ? `L${item.range.startLine}` : ''));
            head.append(aiButton(flow.id));
            row.append(head);
            const reads = flowRefs(flow.reads, nodes, '读取');
            const writes = flowRefs(flow.writes, nodes, '写入');
            const watches = flowRefs(flow.watches, nodes, 'watch');
            if (reads) row.append(reads);
            if (writes) row.append(writes);
            if (watches) row.append(watches);
            if (flow.templateLines.length) {
                const part = el('div', 'flow-part');
                part.append(el('span', 'flow-label', '模板'));
                for (const line of flow.templateLines.slice(0, 8)) {
                    const jump = button(`L${line}`, 'revealLine', undefined, 'flow-ref');
                    jump.dataset.line = String(line);
                    part.append(jump);
                }
                row.append(part);
            }
            if (!reads && !writes && !watches && !flow.templateLines.length) {
                row.append(el('div', 'contract-note', '本文件内未见读写或模板引用。'));
            }
            const host = el('div', 'ai-host');
            host.dataset.aiScope = flow.id;
            row.append(host);
            list.append(row);
        }
        return list;
    }

    const FLOW_LIMIT = 24;

    function renderContract(result, nodes) {
        const contract = result.contract;
        if (!contract) return [];
        const blocks = [];
        if (contract.props.length) {
            const section = el('section', 'contract-section');
            section.append(el('h3', 'block-heading', `组件入参 · props（${result.pagination?.propCount ?? contract.props.length}）`));
            section.append(renderProps(contract.props, nodes));
            blocks.push(section);
        }
        if (contract.emits.length) {
            const section = el('section', 'contract-section');
            section.append(el('h3', 'block-heading', `对外事件 · emits（${result.pagination?.emitCount ?? contract.emits.length}）`));
            section.append(renderEmits(contract.emits, nodes));
            blocks.push(section);
        }
        if (contract.slots.length) {
            const section = el('section', 'contract-section');
            section.append(el('h3', 'block-heading', `插槽 · slots（${contract.slots.length}）`));
            section.append(renderSlots(contract.slots));
            blocks.push(section);
        }
        if (contract.injections.length) {
            const section = el('section', 'contract-section');
            section.append(el('h3', 'block-heading', `依赖注入 · provide / inject（${contract.injections.length}）`));
            section.append(renderInjections(contract.injections));
            blocks.push(section);
        }
        if (contract.props.length || contract.emits.length) {
            const section = el('section', 'contract-section');
            section.append(el('h3', 'block-heading', '契约校验 · 父组件传参'));
            section.append(el('p', 'hint', '按需核对引用本文件的父组件模板，不建索引、可随时中断。'));
            const host = el('div', 'cross-host');
            host.dataset.contractHost = '1';
            section.append(host);
            blocks.push(section);
        }
        return blocks;
    }

    function renderFlowSection(result, nodes) {
        const flows = result.contract?.flows ?? [];
        const active = flows.filter(flow => flow.reads.length || flow.writes.length
            || flow.watches.length || flow.templateLines.length);
        if (!active.length) return null;
        const section = el('section', 'contract-section');
        section.append(el('h3', 'block-heading',
            `状态流转 · 谁读谁写（${result.pagination?.flowCount ?? flows.length}）`));
        section.append(el('p', 'hint', '读取/写入都来自本文件可见的代码；跨文件读写不在范围内。'));
        section.append(renderFlows(active.slice(0, FLOW_LIMIT), nodes));
        if (active.length > FLOW_LIMIT) {
            section.append(el('p', 'overflow-note',
                `还有 ${active.length - FLOW_LIMIT} 项状态，可切换到完整结构查看。`));
        }
        return section;
    }

    const TIMELINE_LIMIT = 40;

    function renderTimeline(result) {
        const steps = result.timeline ?? [];
        if (!steps.length) return null;
        const total = result.pagination?.timelineCount ?? steps.length;
        const section = el('section', 'contract-section');
        section.append(el('h3', 'block-heading', `初始化与生命周期 · 顺序推定（${total}）`));
        section.append(el('p', 'hint', '顺序按源码出现位置推定，不代表运行时真实执行顺序。'));
        const list = el('div', 'timeline-list');
        for (const step of steps.slice(0, TIMELINE_LIMIT)) {
            const row = el('div', 'timeline-row');
            row.append(el('span', 'timeline-kind', step.kind));
            if (step.id) {
                row.append(button(step.name, 'reveal', step.id, 'timeline-name'));
            } else {
                row.append(el('span', 'timeline-name', step.name));
            }
            row.append(el('span', 'line-mark', `L${step.line}`));
            list.append(row);
        }
        section.append(list);
        if (total > TIMELINE_LIMIT) {
            section.append(el('p', 'overflow-note',
                `还有 ${total - TIMELINE_LIMIT} 步，可切换到完整结构查看。`));
        }
        return section;
    }

    const FUNCTION_LIMIT = 12;

    function functionRefs(refs, label) {
        if (!refs.length) return null;
        const part = el('div', 'flow-part');
        part.append(el('span', 'flow-label', label));
        for (const ref of refs) {
            part.append(button(ref.name, 'reveal', ref.id, 'flow-ref'));
            part.append(el('span', 'flow-line', `L${ref.line}`));
        }
        return part;
    }

    function renderFunctions(result) {
        const cards = result.functions ?? [];
        if (!cards.length) return null;
        const total = result.pagination?.functionCount ?? cards.length;
        const section = el('section', 'contract-section');
        section.append(el('h3', 'block-heading', `函数卡片 · 签名与影响面（${total}）`));
        section.append(el('p', 'hint', '签名、返回值与调用关系都来自本文件静态语法；跨文件调用不在范围内。'));
        const list = el('div', 'card-list');
        for (const card of cards.slice(0, FUNCTION_LIMIT)) {
            const box = el('div', 'fn-card');
            const head = el('div', 'node-row');
            head.append(button(card.signature, 'reveal', card.id, 'fn-signature'));
            head.append(el('span', 'line-mark', `L${card.line}`));
            head.append(aiButton(card.id));
            box.append(head);
            const flags = el('div', 'fn-flags');
            if (card.isAsync) flags.append(el('span', 'contract-flag', 'async'));
            flags.append(el('span', `contract-flag ${card.hasReturn ? 'required' : ''}`,
                card.hasReturn ? '有返回' : '无返回'));
            if (card.errorHandling) flags.append(el('span', 'contract-flag', '含错误处理'));
            box.append(flags);
            const callers = functionRefs(card.callers, '被调用');
            const callees = functionRefs(card.callees, '内部调用');
            const writes = functionRefs(card.writes, '写入状态');
            if (callers) box.append(callers);
            if (callees) box.append(callees);
            if (writes) box.append(writes);
            if (!callers && !callees && !writes) {
                box.append(el('div', 'contract-note', '本文件内未见调用或状态写入。'));
            }
            const host = el('div', 'ai-host');
            host.dataset.aiScope = card.id;
            box.append(host);
            const cross = el('div', 'cross-host');
            cross.dataset.crossKey = `symbol:${card.id}`;
            box.append(cross);
            const git = el('div', 'cross-host');
            git.dataset.gitScope = card.id;
            box.append(git);
            list.append(box);
        }
        section.append(list);
        if (total > FUNCTION_LIMIT) {
            section.append(el('p', 'overflow-note',
                `还有 ${total - FUNCTION_LIMIT} 个函数，可切换到完整结构查看。`));
        }
        return section;
    }

    // AI 解读区块：与源码事实（.doc-block / 静态结论）在视觉上明确区分。
    function configureButton() {
        return button('去配置', 'configure', undefined, 'ai-action');
    }

    function aiButton(scope) {
        const pending = aiPending.has(scope);
        const element = button(pending ? 'AI …' : 'AI', 'aiAsk', scope,
            `ai-button${pending ? ' busy' : ''}${aiResult.has(scope) || aiError.has(scope) ? ' done' : ''}`);
        element.disabled = pending;
        element.title = '生成这段代码的 AI 解读';
        return element;
    }

    // AI 解读的极简 markdown 渲染。只覆盖模型实际会用的少量语法，不引入外部依赖；
    // AI 输出属于不可信内容，全部走 textContent / createElement，绝不使用 innerHTML。
    const AI_INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(\*[^*\n]+\*)|(\[L(\d+)(?:\s*-\s*L?(\d+))?\])/g;
    const AI_FENCE = /^```\s*([\w+#.-]*)\s*$/;
    const AI_CODE_LANG = /^(js|javascript|ts|typescript|jsx|tsx|vue|json|bash|sh|shell|zsh|css|html)$/;
    const AI_CODE_TOKEN = /(\/\/[^\n]*|#\s[^\n]*)|('(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`)|(\b\d+(?:\.\d+)?\b)|(\b(?:const|let|var|function|return|else|if|for|while|new|await|async|import|from|export|default|class|extends|this|typeof|instanceof|try|catch|finally|throw|switch|case|break|continue|null|undefined|true|false|of|in|delete|void|yield|setup|props|emits|data|computed|watch|methods|mounted|created)\b)/g;

    /** 代码块：仅对常见语言做一次轻量着色（注释 / 字符串 / 数字 / 关键字），其余语言按纯文本展示。 */
    function aiCodeBlock(language, code) {
        const pre = el('pre', 'ai-pre');
        const body = el('code');
        pre.append(body);
        if (!AI_CODE_LANG.test(language)) { body.textContent = code; return pre; }
        const pattern = new RegExp(AI_CODE_TOKEN.source, 'g');
        let last = 0;
        let match;
        while ((match = pattern.exec(code))) {
            if (match.index > last) body.append(document.createTextNode(code.slice(last, match.index)));
            const kind = match[1] ? 'comment' : match[2] ? 'string' : match[3] ? 'number' : 'keyword';
            body.append(el('span', `c-${kind}`, match[0]));
            last = pattern.lastIndex;
        }
        if (last < code.length) body.append(document.createTextNode(code.slice(last)));
        return pre;
    }

    /** 行内语法：`行内代码`、**加粗**、*斜体*，以及仍然可点击回源码的 [L12] / [L12-L18] 引用。 */
    function aiInline(node, text) {
        const pattern = new RegExp(AI_INLINE.source, 'g');
        let last = 0;
        let match;
        while ((match = pattern.exec(text))) {
            if (match.index > last) node.append(document.createTextNode(text.slice(last, match.index)));
            if (match[1]) node.append(el('code', 'ai-code', match[1].slice(1, -1)));
            else if (match[2]) node.append(el('strong', undefined, match[2].slice(2, -2)));
            else if (match[3]) node.append(el('strong', undefined, match[3].slice(2, -2)));
            else if (match[4]) node.append(el('em', undefined, match[4].slice(1, -1)));
            else {
                const jump = button(match[5], 'revealAiLine', undefined, 'ai-ref');
                jump.dataset.line = String(Number(match[6]));
                node.append(jump);
            }
            last = pattern.lastIndex;
        }
        if (last < text.length) node.append(document.createTextNode(text.slice(last)));
    }

    /**
     * 把 AI 输出按 markdown 排版：标题降级为 h3~h6、无序/有序列表、引用与围栏代码块。
     * 解读本身被要求写得短，所以这里只做结构排版，不做折叠或分页。
     */
    function aiText(text) {
        const wrap = el('div', 'ai-text');
        const lines = String(text || '').split(/\r?\n/);
        let list = null;
        let quote = null;
        const closeBlocks = () => { list = null; quote = null; };

        for (let index = 0; index < lines.length; index++) {
            const line = lines[index].trim();
            if (!line) { closeBlocks(); continue; }

            const fence = line.match(AI_FENCE);
            if (fence) {
                closeBlocks();
                const body = [];
                for (index++; index < lines.length && !/^```/.test(lines[index].trim()); index++) {
                    body.push(lines[index]);
                }
                wrap.append(aiCodeBlock(fence[1].toLowerCase(), body.join('\n')));
                continue;
            }

            const heading = line.match(/^(#{1,4})\s+(.*)$/);
            if (heading) {
                closeBlocks();
                const title = el(`h${Math.min(2 + heading[1].length, 6)}`, 'ai-h');
                aiInline(title, heading[2]);
                wrap.append(title);
                continue;
            }

            const bullet = line.match(/^[-*+]\s+(.*)$/);
            const ordered = line.match(/^\d+[.)]\s+(.*)$/);
            if (bullet || ordered) {
                quote = null;
                if (!list || (list.tagName === 'UL') !== Boolean(bullet)) {
                    list = el(bullet ? 'ul' : 'ol', 'ai-list');
                    wrap.append(list);
                }
                const item = el('li');
                aiInline(item, bullet ? bullet[1] : ordered[1]);
                list.append(item);
                continue;
            }

            const quoted = line.match(/^>\s?(.*)$/);
            if (quoted) {
                list = null;
                if (!quote) { quote = el('blockquote', 'ai-quote'); wrap.append(quote); }
                const paragraph = el('p');
                aiInline(paragraph, quoted[1]);
                quote.append(paragraph);
                continue;
            }

            closeBlocks();
            const paragraph = el('p', 'ai-p');
            aiInline(paragraph, line);
            wrap.append(paragraph);
        }
        return wrap;
    }

    function aiBlock(scope) {
        const info = state.ai || {};
        const result = aiResult.get(scope);
        const error = aiError.get(scope);
        const pending = aiPending.has(scope);
        // 节点级区块只在有内容时出现，避免每张卡片都多出一块空档。
        if (scope !== 'file' && !pending && !result && !error) return null;
        const block = el('section', 'ai-block');
        const head = el('div', 'ai-head');
        head.append(el('span', 'ai-badge', 'AI 推断'));
        head.append(el('span', 'ai-title', scope === 'file' ? 'AI 解读' : 'AI 节点解读'));
        if (pending) {
            head.append(el('span', 'ai-status', '正在生成…'));
        } else if (result) {
            head.append(el('span', 'ai-status', `模型 ${result.model || info.model || '未注明'}`));
            head.append(button('重新生成', 'aiForce', scope, 'ai-action'));
        }
        block.append(head);
        if (pending) {
            block.append(el('p', 'ai-note', '正在请求模型，结论会带上可点击的行号。'));
            return block;
        }
        if (error) {
            block.append(el('p', 'ai-note', error));
            if (info.issue) block.append(configureButton());
            else block.append(button('重试', 'aiForce', scope, 'ai-action'));
            return block;
        }
        if (result) {
            if (result.text) block.append(aiText(result.text));
            else block.append(el('p', 'ai-note', '模型没有给出可定位的解读。'));
            if (result.dropped) {
                block.append(el('p', 'ai-note',
                    `已过滤 ${result.dropped} 处无法定位到本文件的行号引用。`));
            }
            const evidence = result.evidence || [];
            if (evidence.length) {
                const refs = el('div', 'ai-refs');
                refs.append(el('span', 'ai-note', '依据行：'));
                for (const line of evidence.slice(0, 12)) {
                    const jump = button(`L${line}`, 'revealAiLine', undefined, 'ai-ref');
                    jump.dataset.line = String(line);
                    refs.append(jump);
                }
                block.append(refs);
            }
            block.append(el('p', 'ai-note', '以上为模型推断，仅供阅读参考；源码事实以上方静态结论为准。'));
            return block;
        }
        if (!info.enabled) {
            block.append(el('p', 'ai-note',
                '未启用 AI 解读。开启后只发送结构化摘要与必要的源码切片，不会上传整个工作区。'));
            block.append(configureButton());
            return block;
        }
        if (info.issue) {
            block.append(el('p', 'ai-note', info.issue));
            block.append(configureButton());
            return block;
        }
        block.append(el('p', 'ai-note', scope === 'file'
            ? '按需生成一段解读：只依据上面的静态事实，结论带行号，可点击回到源码。'
            : '生成该节点的解读：只依据本文件静态事实与这段源码。'));
        block.append(button(scope === 'file' ? '生成解读' : '生成节点解读', 'aiAsk', scope, 'ai-action'));
        return block;
    }

    // 只刷新 AI 相关 DOM，避免整页重绘导致滚动位置跳动。
    function refreshAi() {
        for (const host of root.querySelectorAll('[data-ai-scope]')) {
            const block = aiBlock(host.dataset.aiScope);
            host.replaceChildren();
            if (block) host.append(block);
        }
        for (const element of root.querySelectorAll('.ai-button')) {
            const scope = element.dataset.value;
            const pending = aiPending.has(scope);
            element.textContent = pending ? 'AI …' : 'AI';
            element.disabled = pending;
            element.className = `ai-button${pending ? ' busy' : ''}${
                aiResult.has(scope) || aiError.has(scope) ? ' done' : ''}`;
        }
    }

    function requestAi(scope, force) {
        aiPending.add(scope);
        aiError.delete(scope);
        if (force) aiResult.delete(scope);
        refreshAi();
        vscode.postMessage({ type: 'aiInsight', scope, force: force || undefined });
    }

    // 跨文件证据：与 AI 不同，这是确定性检索结果。按需触发、结果有上限，
    // 面板侧不建索引，所以这里只负责展示与状态回收。
    let crossPending = new Set();
    let crossResult = new Map();
    let crossError = new Map();

    function crossLabel(key) {
        return key === 'importers' ? '检索引用方' : '检索跨文件调用点';
    }

    function crossRows(rows, kind) {
        const list = el('div', 'cross-list');
        for (const row of rows) {
            const item = el('div', 'cross-row');
            const head = el('div', 'node-row');
            const jump = button(row.file, 'crossOpen', undefined, 'cross-file');
            jump.dataset.file = row.absolute;
            jump.dataset.line = String(row.line);
            jump.title = '在编辑器中打开该位置';
            head.append(jump);
            head.append(el('span', 'line-mark', `L${row.line}`));
            if (row.certainty === 'unresolved') head.append(el('span', 'contract-flag', '未确认'));
            if (kind === 'symbol') {
                head.append(el('span', 'contract-flag', row.kind === 'call' ? '疑似调用' : '仅出现'));
            }
            item.append(head);
            item.append(el('div', 'cross-detail', kind === 'symbol' ? row.text : row.detail));
            list.append(item);
        }
        return list;
    }

    function crossGroup(title, rows, kind) {
        const group = el('div', 'cross-group');
        group.append(el('div', 'cross-group-head', `${title}（${rows.length}）`));
        if (!rows.length) group.append(el('p', 'ai-note', '无。'));
        else group.append(crossRows(rows, kind));
        return group;
    }

    function crossBlock(key) {
        const kind = key === 'importers' ? 'importers' : 'symbol';
        const pending = crossPending.has(key);
        const result = crossResult.get(key);
        const error = crossError.get(key);
        // 函数卡片里每个节点都挂一个入口，空闲态只留一行按钮，避免面板被塞满。
        if (!result && !error && !pending && kind === 'symbol') {
            return button(crossLabel(key), 'crossRef', key, 'ai-action');
        }
        const block = el('section', 'cross-block');
        const head = el('div', 'cross-head');
        head.append(el('span', 'cross-badge', '跨文件'));
        head.append(el('span', 'cross-title', kind === 'importers' ? '谁引用了我' : '跨文件调用点'));
        if (pending) head.append(el('span', 'ai-status', '正在检索…'));
        else if (result) head.append(button('重新检索', 'crossRef', key, 'ai-action'));
        block.append(head);
        if (pending) {
            block.append(el('p', 'ai-note', '正在当前工作区内检索，随时切换文件即可中断。'));
            return block;
        }
        if (error) {
            block.append(el('p', 'ai-note', error));
            block.append(button(crossLabel(key), 'crossRef', key, 'ai-action'));
            return block;
        }
        if (!result) {
            block.append(el('p', 'ai-note', kind === 'importers'
                ? '按需检索工作区内引用本文件的位置：能解析回本文件的进「确定」，其余命中放「未确认」。'
                : '按需检索本文件之外使用该符号的位置。这一档只按名字匹配，属于候选，需人工确认。'));
            block.append(button(crossLabel(key), 'crossRef', key, 'ai-action'));
            return block;
        }
        if (kind === 'importers') {
            const certain = result.importers.filter(row => row.certainty === 'certain');
            const unresolved = result.importers.filter(row => row.certainty !== 'certain');
            block.append(crossGroup('确定引用', certain, 'importers'));
            block.append(crossGroup('未确认命中', unresolved, 'importers'));
        } else {
            block.append(crossGroup('候选位置', result.hits, 'symbol'));
        }
        const engine = result.engine === 'git' ? 'git grep' : '有界文件扫描';
        block.append(el('p', 'cross-meta', `${engine} · ${result.durationMs} ms${
            result.truncated ? ' · 结果已截断' : ''}`));
        if (result.note) block.append(el('p', 'ai-note', result.note));
        if (kind === 'symbol') {
            block.append(el('p', 'ai-note', '以上为名字匹配的候选位置，不代表真实调用关系；确定结论仍以上方静态分析为准。'));
        }
        return block;
    }

    function refreshCrossRef() {
        for (const host of root.querySelectorAll('[data-cross-key]')) {
            const block = crossBlock(host.dataset.crossKey);
            host.replaceChildren();
            if (block) host.append(block);
        }
    }

    function requestCrossRef(key) {
        crossPending.add(key);
        crossResult.delete(key);
        crossError.delete(key);
        refreshCrossRef();
        vscode.postMessage({
            type: 'crossRef',
            kind: key === 'importers' ? 'importers' : 'symbol',
            value: key,
            id: key === 'importers' ? undefined : key.slice('symbol:'.length)
        });
    }

    function crossSection() {
        const section = el('section', 'contract-section');
        section.append(el('h3', 'block-heading', '跨文件 · 谁引用了我'));
        section.append(el('p', 'hint', '按需检索，结果有上限并可随时中断；不在工作区内的文件不参与。'));
        const host = el('div', 'cross-host');
        host.dataset.crossKey = 'importers';
        section.append(host);
        return section;
    }

    // Git 溯源：函数级 blame。只对点开的那个函数取一次行区间，不建索引、不落缓存，
    // 非 git 仓库 / 未装 git 只在点开后就地说明原因，不阻塞其它能力。
    let gitPending = new Set();
    let gitTrace = new Map();
    let gitError = new Map();

    function gitAgo(seconds) {
        const past = Math.max(0, Math.floor(Date.now() / 1000) - seconds);
        if (past < 60) return '刚刚';
        if (past < 3600) return `${Math.floor(past / 60)} 分钟前`;
        if (past < 86400) return `${Math.floor(past / 3600)} 小时前`;
        if (past < 2592000) return `${Math.floor(past / 86400)} 天前`;
        if (past < 31536000) return `${Math.floor(past / 2592000)} 个月前`;
        return `${Math.floor(past / 31536000)} 年前`;
    }

    function gitBlock(id) {
        const pending = gitPending.has(id);
        const trace = gitTrace.get(id);
        const error = gitError.get(id);
        // 每张函数卡片默认只留一行入口，避免面板被塞满。
        if (!trace && !error && !pending) {
            return button('谁改的', 'gitTrace', id, 'ai-action');
        }
        const block = el('section', 'cross-block');
        const head = el('div', 'cross-head');
        head.append(el('span', 'cross-badge', 'Git'));
        head.append(el('span', 'cross-title', '改动来源'));
        if (pending) head.append(el('span', 'ai-status', '正在读取…'));
        else head.append(button('重新读取', 'gitTrace', id, 'ai-action'));
        block.append(head);
        if (pending) {
            block.append(el('p', 'ai-note', '正在读取本地 git 记录，切换文件即可中断。'));
            return block;
        }
        if (error) {
            block.append(el('p', 'ai-note', error));
            return block;
        }
        if (trace.untracked && !trace.authors.length) {
            block.append(el('p', 'ai-note', `本区间 ${trace.totalLines} 行都还没有提交记录（文件尚未被 git 跟踪）。`));
        } else {
            const latest = el('div', 'git-latest');
            if (trace.latest) {
                const row = el('div', 'node-row');
                row.append(el('span', 'git-author', trace.latest.author || '未知作者'));
                row.append(el('span', 'line-mark', gitAgo(trace.latest.time)));
                row.append(el('span', 'line-mark', `${trace.latest.lines} 行归属此提交`));
                latest.append(row);
                if (trace.latest.summary) latest.append(el('div', 'cross-detail', trace.latest.summary));
            } else {
                latest.append(el('p', 'ai-note', '本区间没有已提交的行。'));
            }
            block.append(latest);
            if (trace.authors.length > 1) {
                block.append(el('p', 'cross-meta', `区间内作者：${
                    trace.authors.map(item => `${item.author || '未知'}（${item.lines} 行）`).join('、')}`));
            }
        }
        if (trace.dirtyLines > 0) {
            block.append(el('p', 'ai-note', `本区间有 ${trace.dirtyLines} 行是本地未提交改动。`));
        }
        if (trace.unsaved) {
            block.append(el('p', 'ai-note', '编辑器内有未保存改动，行号以磁盘版本为准。'));
        }
        block.append(el('p', 'cross-meta', `git blame · ${trace.durationMs} ms`));
        return block;
    }

    function refreshGitTrace() {
        for (const host of root.querySelectorAll('[data-git-scope]')) {
            const block = gitBlock(host.dataset.gitScope);
            host.replaceChildren();
            if (block) host.append(block);
        }
    }

    function requestGitTrace(id) {
        gitPending.add(id);
        gitTrace.delete(id);
        gitError.delete(id);
        refreshGitTrace();
        vscode.postMessage({ type: 'gitTrace', id });
    }

    // 契约校验：用本文件的 props / emits 核对父组件模板。同样是按需触发、结果有上限。
    let contractState = null;

    function contractBlock() {
        const current = contractState;
        if (!current) return button('校验父组件传参', 'contractCheck', undefined, 'ai-action');
        const block = el('section', 'cross-block');
        const head = el('div', 'cross-head');
        head.append(el('span', 'cross-badge', '契约'));
        head.append(el('span', 'cross-title', '父组件传参核对'));
        if (current.state === 'pending') head.append(el('span', 'ai-status', '正在核对…'));
        else head.append(button('重新校验', 'contractCheck', undefined, 'ai-action'));
        block.append(head);
        if (current.state === 'pending') {
            block.append(el('p', 'ai-note', '正在读取引用本文件的父组件，切换文件即可中断。'));
            return block;
        }
        if (current.state !== 'ready') {
            block.append(el('p', 'ai-note', current.message || '契约校验当前不可用。'));
            return block;
        }
        const result = current.result;
        block.append(el('p', 'cross-meta', `核对 ${result.parents} 个父组件 · ${result.usages} 个使用点`
            + ` · ${result.durationMs} ms${result.truncated ? ' · 结果已截断' : ''}`));
        const total = result.reports.reduce((sum, item) => sum + item.issues.length, 0);
        if (!total) {
            block.append(el('p', 'ai-note', '已核对的父组件里没有发现漏传必填 prop、未声明 prop 或未声明事件。'));
        }
        for (const report of result.reports) {
            const group = el('div', 'cross-group');
            group.append(el('div', 'cross-group-head', `${report.file}（${report.usages} 个使用点）`));
            if (!report.issues.length) {
                group.append(el('p', 'ai-note', '无问题。'));
            } else {
                const list = el('div', 'cross-list');
                for (const issue of report.issues) {
                    const row = el('div', 'cross-row');
                    const meta = el('div', 'node-row');
                    const jump = button(`L${issue.line}`, 'crossOpen', undefined, 'cross-file');
                    jump.dataset.file = report.absolute;
                    jump.dataset.line = String(issue.line);
                    meta.append(jump);
                    meta.append(el('span', `contract-flag${issue.certainty === 'certain' ? ' required' : ''}`,
                        issue.certainty === 'certain' ? '确定' : '候选'));
                    row.append(meta);
                    row.append(el('div', 'cross-detail', issue.detail));
                    list.append(row);
                }
                group.append(list);
            }
            block.append(group);
        }
        if (result.note) block.append(el('p', 'ai-note', result.note));
        block.append(el('p', 'ai-note',
            '结论只基于模板里写出来的属性；`v-bind` 整体透传、mixin 与全局注册的组件不参与判定。'));
        return block;
    }

    function refreshContract() {
        for (const host of root.querySelectorAll('[data-contract-host]')) {
            const block = contractBlock();
            host.replaceChildren();
            if (block) host.append(block);
        }
    }

    function requestContractCheck() {
        contractState = { state: 'pending' };
        refreshContract();
        vscode.postMessage({ type: 'contractCheck' });
    }

    // 面板内检索：命中来自宿主侧对「完整」分析结果的扫描（含还没分页发过来的部分），
    // 这里只做输入防抖与结果展示，输入本身不触发重新分析。
    const FILTER_MIN = 2;
    let filterText = '';
    let filterState = null;
    let filterTimer = 0;

    function filterList() {
        if (!filterState) return null;
        const list = el('div', 'filter-list');
        if (!filterState.matches.length) {
            list.append(el('p', 'ai-note', `没有名字含「${filterState.text.trim()}」的节点。`));
            return list;
        }
        for (const item of filterState.matches) {
            const row = el('div', 'node-row');
            row.append(button(item.name, 'reveal', item.id));
            row.append(el('span', 'contract-kind', item.kind));
            row.append(el('span', 'line-mark', `L${item.line}`));
            list.append(row);
        }
        const shown = filterState.matches.length;
        if (filterState.total > shown) {
            list.append(el('p', 'overflow-note',
                `还有 ${filterState.total - shown} 处匹配，继续输入可缩小范围。`));
        }
        return list;
    }

    function renderFilter() {
        const bar = el('div', 'filter-bar');
        const input = el('input', 'filter-input');
        input.type = 'search';
        input.placeholder = `检索本文件节点（${FILTER_MIN} 个字符起）`;
        input.value = filterText;
        input.dataset.filterInput = '1';
        input.setAttribute('aria-label', '按名字检索本文件节点');
        input.addEventListener('input', () => {
            filterText = input.value;
            window.clearTimeout(filterTimer);
            // 防抖：逐字回传会让宿主反复扫全量节点，输入停顿后再发。
            filterTimer = window.setTimeout(() => {
                if (filterText.trim().length < FILTER_MIN) {
                    filterState = null;
                    refreshFilter();
                    return;
                }
                vscode.postMessage({ type: 'filter', text: filterText });
            }, 160);
        });
        bar.append(input);
        return bar;
    }

    function refreshFilter() {
        const host = root.querySelector('[data-filter-host]');
        if (!host) return;
        const list = filterList();
        host.replaceChildren();
        if (list) host.append(list);
    }

    function renderHeader() {
        const header = el('header', 'masthead');
        const top = el('div', 'masthead-top');
        top.append(el('span', 'brand-mark', '//'));
        top.append(el('span', 'brand-name', '代码理解'));
        top.append(button('刷新', 'refresh', undefined, 'refresh-button'));
        header.append(top);
        const name = state.name ? state.name.replace(/\\/g, '/').split('/').pop() : '等待文件';
        header.append(el('div', 'file-name', name));
        if (state.result) {
            const summary = el('div', 'file-meta');
            summary.append(el('span', '', `${state.result.meta.totalLines} 行`));
            summary.append(el('span', '', `${state.result.pagination?.entryCount ?? state.result.guide.entries.length} 个入口`));
            summary.append(el('span', '', `${state.durationMs ?? 0} ms`));
            header.append(summary);
        }
        return header;
    }

    function renderTabs() {
        const tabs = el('div', 'tabs');
        tabs.setAttribute('role', 'tablist');
        for (const [id, label] of [['guide', '阅读路径'], ['structure', '完整结构']]) {
            const item = button(label, 'tab', id, `tab ${tab === id ? 'selected' : ''}`);
            item.setAttribute('role', 'tab');
            item.setAttribute('aria-selected', String(tab === id));
            tabs.append(item);
        }
        return tabs;
    }

    function nodeMap(result) {
        return new Map(result.nodes.map(node => [node.id, node]));
    }

    function renderRoute(entryId, result, nodes) {
        const start = nodes.get(entryId);
        if (!start) return null;
        const route = el('div', 'route');
        route.append(el('div', 'route-kicker', start.kind === 'event' ? '模板入口' : '文件入口'));
        route.append(textLine(start));
        const seen = new Set([entryId]);
        let frontier = [entryId];
        let steps = 0;
        while (frontier.length && steps < 3) {
            const next = [];
            for (const from of frontier) {
                for (const edge of result.paths) {
                    if (edge.from !== from || steps >= 4) continue;
                    const row = el('div', `edge ${edge.certainty}`);
                    row.append(el('span', 'edge-type', {
                        'event-handler': '触发',
                        calls: '调用',
                        writes: '写入',
                        exports: '导出',
                        returns: '返回'
                    }[edge.type] || edge.type));
                    const target = edge.to && nodes.get(edge.to);
                    if (target && edge.certainty === 'certain') {
                        row.append(button(target.name, 'reveal', target.id));
                        if (!seen.has(target.id)) {
                            seen.add(target.id);
                            next.push(target.id);
                        }
                    } else {
                        row.append(el('span', 'unknown', edge.targetName || '目标未确认'));
                    }
                    const proof = button(`依据 L${edge.evidence.startLine}`, 'evidence', from, 'evidence');
                    proof.dataset.index = String(edge.index);
                    row.append(proof);
                    route.append(row);
                    steps++;
                }
            }
            frontier = next;
        }
        return route;
    }

    function renderGuide(result) {
        const nodes = nodeMap(result);
        const content = el('main', 'content');
        const modes = el('div', 'mode-switch');
        modes.append(button('了解文件', 'showFile', undefined,
            `mode-button ${state.mode !== 'function' ? 'active' : ''}`));
        modes.append(button('准备修改函数', 'focus', undefined,
            `mode-button ${state.mode === 'function' ? 'active' : ''}`));
        content.append(modes);
        if (state.focusMessage) content.append(el('p', 'diagnostic', state.focusMessage));
        if (state.mode === 'function' && state.focusId) {
            const focused = nodes.get(state.focusId);
            content.append(el('div', 'eyebrow', '01 / CHANGE CONTEXT'));
            content.append(el('h2', 'section-title', focused ? `准备修改 ${focused.name}` : '准备修改函数'));
            content.append(el('p', 'hint', '只展示本文件可确认的入口与关系；调用方不等于所有运行时来源。'));
            const incoming = result.paths.filter(edge =>
                edge.to === state.focusId && edge.certainty === 'certain').slice(0, 12);
            if (incoming.length) {
                content.append(el('h3', 'block-heading', '从哪里到达这里'));
                for (const edge of incoming) {
                    const source = nodes.get(edge.from);
                    if (!source) continue;
                    const row = el('div', 'focus-incoming');
                    row.append(textLine(source));
                    row.append(el('span', 'edge-type', `${edge.type} · L${edge.evidence.startLine}`));
                    content.append(row);
                }
            }
            content.append(el('h3', 'block-heading', '内部调用与状态变化'));
            const route = renderRoute(state.focusId, result, nodes);
            if (route) content.append(route);
            return content;
        }
        content.append(el('div', 'eyebrow', '01 / FILE READING'));
        content.append(el('h2', 'section-title', '先看脉络，再看细节'));
        const summary = result.guide.summary;
        if (summary?.origin === 'comment') {
            const quote = el('blockquote', 'author-quote');
            quote.append(el('p', 'intro', summary.text));
            const source = button(`作者原话 · L${summary.evidence[0] ?? '-'}`, 'revealLine',
                undefined, 'quote-source');
            source.dataset.line = String(summary.evidence[0] ?? '');
            quote.append(source);
            content.append(quote);
        } else {
            content.append(el('p', 'intro',
                summary?.text || '暂无法从源码确认文件职责。先从可识别的声明开始阅读。'));
        }
        const hint = el('p', 'hint', '摘要与实际连线都只来自本文件；连线不代表完整运行时路径。');
        content.append(hint);
        // 文件级 AI 解读：与「作者原话」并列，但视觉上明确标为模型推断。
        const aiHost = el('div', 'ai-host');
        aiHost.dataset.aiScope = 'file';
        content.append(aiHost);
        if (result.errors.length) {
            const warning = el('div', 'diagnostic',
                `${result.pagination?.errorCount ?? result.errors.length} 处解析提示；已保留可识别的结构。`);
            content.append(warning);
        }
        content.append(el('h3', 'block-heading', '关键入口与路径'));
        const entries = result.guide.entries.length
            ? result.guide.entries
            : result.script.declarations.slice(0, 8);
        if (!entries.length) {
            content.append(el('p', 'empty-note', '当前文件没有可确认的入口。可在“完整结构”中查看已识别节点。'));
        }
        for (const id of entries.slice(0, 8)) {
            const route = renderRoute(id, result, nodes);
            if (route) content.append(route);
        }
        const moreEntries = (result.pagination?.entryCount ?? entries.length) - entries.length;
        if (moreEntries > 0) {
            content.append(el('p', 'overflow-note', `还有 ${moreEntries} 个入口，可切换到完整结构继续查看。`));
        }
        for (const block of renderContract(result, nodes)) content.append(block);
        const flows = renderFlowSection(result, nodes);
        if (flows) content.append(flows);
        const timeline = renderTimeline(result);
        if (timeline) content.append(timeline);
        const functions = renderFunctions(result);
        if (functions) content.append(functions);
        content.append(crossSection());
        if (result.guide.state.length) {
            content.append(el('h3', 'block-heading', '关键状态'));
            const list = el('div', 'state-list');
            for (const id of result.guide.state.slice(0, 12)) {
                const node = nodes.get(id);
                if (node) list.append(textLine(node));
            }
            content.append(list);
        }
        const notes = renderNotes(result, 8);
        if (notes) {
            content.append(el('h3', 'block-heading', '待办与备注'));
            content.append(notes);
        }
        return content;
    }

    function pager(total, offset, action, key) {
        if (total <= 50) return null;
        const controls = el('div', 'pager');
        const previous = button('上一页', action, key, 'pager-button');
        const next = button('下一页', action, key, 'pager-button');
        previous.dataset.offset = String(Math.max(0, offset - 50));
        next.dataset.offset = String(offset + 50);
        previous.disabled = offset === 0;
        next.disabled = offset + 50 >= total;
        controls.append(previous, el('span', 'page-label',
            `${offset + 1}-${Math.min(offset + 50, total)} / ${total}`), next);
        return controls;
    }

    function renderTemplate(items, parentId, offset = 0, total = items.length) {
        const list = el('div', parentId === null ? 'tree-root template-page' : 'tree-children template-page');
        list.dataset.parentId = parentId ?? '__root__';
        for (const item of items) {
            const row = el('div', 'tree-item');
            if (item.children.length || item.hasChildren) {
                const details = el('details', 'tree-group');
                details.dataset.templateId = item.id;
                details.open = true;
                const heading = el('summary', 'tree-heading');
                heading.append(el('span', `tag ${item.isComponent ? 'custom' : ''}`, `<${item.tag}>`));
                heading.append(el('span', 'line-mark', `L${item.range.startLine}`));
                details.append(heading);
                details.append(button('跳转源码', 'reveal', item.id, 'tree-jump'));
                if (item.children.length) {
                    details.append(renderTemplate(item.children, item.id));
                    details.dataset.loaded = 'true';
                } else {
                    const pending = el('div', 'tree-children template-page');
                    pending.dataset.parentId = item.id;
                    details.append(pending);
                }
                row.append(details);
            } else {
                row.append(textLine({ id: item.id, name: `<${item.tag}>`, range: item.range }));
            }
            list.append(row);
        }
        const controls = pager(total, offset, 'pageTemplate', parentId ?? '__root__');
        if (controls) list.append(controls);
        return list;
    }

    const AUTO_LOAD_LIMIT = 30;

    // 只补载“已展开且祖先都展开”的分页节点，避免折叠状态下发起无谓请求。
    function withinOpenDetails(element) {
        let parent = element.parentElement;
        while (parent) {
            if (parent.tagName === 'DETAILS' && !parent.open) { return false; }
            parent = parent.parentElement;
        }
        return true;
    }

    function loadOpenTemplatePages() {
        if (state.status !== 'ready' || tab !== 'structure') { return; }
        const pending = [...root.querySelectorAll('details[data-template-id]:not([data-loaded])')]
            .filter(item => item.open && withinOpenDetails(item));
        for (const details of pending.slice(0, AUTO_LOAD_LIMIT)) {
            details.dataset.loaded = 'true';
            vscode.postMessage({
                type: 'pageTemplate', parentId: details.dataset.templateId,
                offset: 0, publicationId: state.publicationId
            });
        }
    }

    function renderSectionBody(ids, nodes, key, offset, total) {
        const body = el('div', 'section-body');
        for (const id of ids) {
            const item = nodes.get(id);
            if (!item) continue;
            body.append(textLine(item));
            if (item.children?.length) {
                const children = el('div', 'tree-children');
                for (const childId of item.children) {
                    const child = nodes.get(childId);
                    if (child) children.append(textLine(child));
                }
                body.append(children);
            }
        }
        const controls = pager(total, offset, 'pageSection', key);
        if (controls) body.append(controls);
        return body;
    }

    function renderSection(title, ids, nodes, key, total) {
        if (!total) return null;
        const section = el('details', 'structure-section');
        section.dataset.sectionKey = key;
        const summary = el('summary', 'structure-heading');
        summary.append(el('span', '', title));
        summary.append(el('span', 'section-count', total));
        section.append(summary);
        const body = renderSectionBody(ids, nodes, key, 0, total);
        section.append(body);
        return section;
    }

    function renderStructure(result) {
        const nodes = nodeMap(result);
        const content = el('main', 'content');
        content.append(el('div', 'eyebrow', '02 / SOURCE INDEX'));
        content.append(el('h2', 'section-title', '完整结构'));
        content.append(el('p', 'intro', '展开区块，点击节点回到原文件。'));
        if (result.template) {
            const section = el('details', 'structure-section');
            const heading = el('summary', 'structure-heading', '模板组件树');
            section.append(heading);
            section.append(renderTemplate(result.template.tree, null, 0,
                result.pagination?.templateCount ?? result.template.tree.length));
            content.append(section);
        }
        for (const [name, key, ids] of [
            ['导出', 'exports', result.script.exports],
            ['导入', 'imports', result.imports],
            ['函数与声明', 'declarations', result.script.declarations],
            ['Props', 'props', result.script.props],
            ['状态', 'data', result.script.data],
            ['Computed', 'computed', result.script.computed],
            ['Watch', 'watch', result.script.watch],
            ['生命周期', 'hooks', result.script.hooks]
        ]) {
            const section = renderSection(name, ids, nodes, key, result.pagination?.sections[key] ?? ids.length);
            if (section) content.append(section);
        }
        for (const [index, group] of result.script.groups.entries()) {
            const key = `group:${index}`;
            const section = renderSection(group.label, group.methods, nodes, key,
                result.pagination?.sections[key] ?? group.methods.length);
            if (section) content.append(section);
        }
        const notes = renderNotes(result, 40);
        if (notes) {
            content.append(el('h3', 'block-heading', 'TODO 与备注'));
            content.append(notes);
        }
        if (result.errors.length) {
            content.append(el('h3', 'block-heading', '解析提示'));
            for (const error of result.errors.slice(0, 20)) {
                content.append(el('p', 'diagnostic', `${error.line ? `L${error.line} · ` : ''}${error.message}`));
            }
        }
        return content;
    }

    function render() {
        // 输入框会被整页重绘覆盖，先记住它是否聚焦，重绘后把光标补回去。
        const active = document.activeElement;
        const keepFilter = Boolean(active && active.dataset && active.dataset.filterInput === '1');
        root.replaceChildren(renderHeader());
        if (state.status !== 'ready' || !state.result) {
            const empty = el('div', 'blank-state');
            empty.append(el('div', 'blank-index', state.status === 'loading' ? '...' : '01'));
            empty.append(el('h2', '', state.status === 'loading' ? '正在梳理代码' : '从一个文件开始'));
            empty.append(el('p', '', state.message || '打开 .vue、.js 或 .ts 文件开始阅读'));
            root.append(empty);
        } else {
            root.append(renderTabs());
            root.append(renderFilter());
            const host = el('div', 'filter-host');
            host.dataset.filterHost = '1';
            root.append(host);
            root.append(tab === 'guide' ? renderGuide(state.result) : renderStructure(state.result));
            if (keepFilter) {
                const input = root.querySelector('[data-filter-input]');
                if (input) {
                    input.focus();
                    input.setSelectionRange(input.value.length, input.value.length);
                }
            }
        }
        vscode.postMessage({
            type: 'applied', file: state.file, status: state.status,
            publicationId: state.publicationId
        });
        refreshAi();
        refreshCrossRef();
        refreshGitTrace();
        refreshContract();
        refreshFilter();
        loadOpenTemplatePages();
    }

    root.addEventListener('click', event => {
        const target = event.target.closest('button[data-action]');
        if (!target) return;
        const action = target.dataset.action;
        if (action === 'tab') {
            tab = target.dataset.value;
            render();
        } else if (action === 'focus' || action === 'showFile') {
            vscode.postMessage({ type: action });
        } else if (action === 'refresh') {
            vscode.postMessage({ type: 'refresh' });
        } else if (action === 'revealLine') {
            vscode.postMessage({ type: 'revealLine', line: Number(target.dataset.line) });
        } else if (action === 'revealAiLine') {
            vscode.postMessage({ type: 'revealAiLine', line: Number(target.dataset.line) });
        } else if (action === 'aiAsk') {
            requestAi(target.dataset.value, false);
        } else if (action === 'aiForce') {
            requestAi(target.dataset.value, true);
        } else if (action === 'configure') {
            vscode.postMessage({ type: 'configure' });
        } else if (action === 'crossRef') {
            requestCrossRef(target.dataset.value);
        } else if (action === 'gitTrace') {
            requestGitTrace(target.dataset.value);
        } else if (action === 'contractCheck') {
            requestContractCheck();
        } else if (action === 'crossOpen') {
            vscode.postMessage({
                type: 'openLocation', file: target.dataset.file, line: Number(target.dataset.line)
            });
        } else if (action === 'reveal' || action === 'evidence') {
            vscode.postMessage({
                type: 'reveal',
                id: target.dataset.value,
                relationIndex: action === 'evidence' ? Number(target.dataset.index) : undefined
            });
        } else if (action === 'pageSection') {
            vscode.postMessage({
                type: 'pageSection', key: target.dataset.value,
                offset: Number(target.dataset.offset), publicationId: state.publicationId
            });
        } else if (action === 'pageTemplate') {
            vscode.postMessage({
                type: 'pageTemplate',
                parentId: target.dataset.value === '__root__' ? null : target.dataset.value,
                offset: Number(target.dataset.offset), publicationId: state.publicationId
            });
        }
    });
    root.addEventListener('toggle', () => loadOpenTemplatePages(), true);
    window.addEventListener('message', event => {
        const message = event.data;
        if (message?.type === 'state') {
            if (state.file !== message.file) tab = 'guide';
            let refilter = false;
            // 文件内容或模型变化时整体作废旧解读，不静默沿用（等价于提示重新生成）。
            const model = (message.ai || {}).model;
            if (state.snapshotId !== message.snapshotId || (state.ai || {}).model !== model) {
                aiResult = new Map();
                aiPending = new Set();
                aiError = new Map();
            }
            // 跨文件检索结果绑在具体文件上，文件一变就整批作废。
            if (state.snapshotId !== message.snapshotId) {
                crossPending = new Set();
                crossResult = new Map();
                crossError = new Map();
                // blame 结论同样绑在具体文件的行号上，一并作废。
                gitPending = new Set();
                gitTrace = new Map();
                gitError = new Map();
                contractState = null;
                // 检索命中绑在旧快照的节点 id 上，一并作废；输入内容保留，重新问一次。
                filterState = null;
                refilter = true;
            }
            state = message;
            render();
            if (refilter && filterText.trim().length >= FILTER_MIN) {
                vscode.postMessage({ type: 'filter', text: filterText });
            }
        } else if (message?.type === 'filter') {
            // 快照已经变了说明这批命中是旧文件上的，直接丢弃。
            if (message.snapshotId !== state.snapshotId) return;
            filterState = { text: message.text, total: message.total, matches: message.matches };
            refreshFilter();
        } else if (message?.type === 'crossRef') {
            crossPending.delete(message.value);
            if (message.state === 'ready') {
                crossResult.set(message.value, message.result);
                crossError.delete(message.value);
            } else if (message.state === 'cancelled') {
                // 切换文件或重新分析导致的主动取消，只回收按钮状态，不展示为失败。
                crossResult.delete(message.value);
                crossError.delete(message.value);
            } else {
                crossResult.delete(message.value);
                crossError.set(message.value, message.message || '跨文件检索失败');
            }
            refreshCrossRef();
        } else if (message?.type === 'gitTrace') {
            gitPending.delete(message.id);
            if (message.state === 'ready') {
                gitTrace.set(message.id, message.trace);
                gitError.delete(message.id);
            } else if (message.state === 'cancelled') {
                gitTrace.delete(message.id);
                gitError.delete(message.id);
            } else {
                gitTrace.delete(message.id);
                gitError.set(message.id, message.message || (message.state === 'unavailable'
                    ? '当前环境无法读取 git 记录。' : '读取 git 记录失败'));
            }
            refreshGitTrace();
        } else if (message?.type === 'contractCheck') {
            // cancelled 只用于回收按钮状态（切文件等主动取消），不展示为失败。
            contractState = message.state === 'cancelled' ? null : message;
            refreshContract();
        } else if (message?.type === 'aiInsight' && message.snapshotId === state.snapshotId) {
            aiPending.delete(message.scope);
            if (message.state === 'ready') {
                aiResult.set(message.scope, message);
                aiError.delete(message.scope);
            } else if (message.state !== 'cancelled') {
                // cancelled 只用于回收按钮状态（改配置等主动取消），不展示为失败。
                aiError.set(message.scope, message.message || 'AI 解读失败');
            }
            refreshAi();
        } else if (message?.type === 'sectionPage' && message.publicationId === state.publicationId) {
            const section = [...root.querySelectorAll('[data-section-key]')]
                .find(item => item.dataset.sectionKey === message.key);
            if (!section) return;
            const nodes = new Map(message.nodes.map(node => [node.id, node]));
            section.querySelector('.section-body')?.replaceWith(
                renderSectionBody(message.ids, nodes, message.key, message.offset, message.total)
            );
        } else if (message?.type === 'templatePage' && message.publicationId === state.publicationId) {
            const key = message.parentId ?? '__root__';
            const page = [...root.querySelectorAll('[data-parent-id]')]
                .find(item => item.dataset.parentId === key);
            page?.replaceWith(renderTemplate(message.items, message.parentId, message.offset, message.total));
            loadOpenTemplatePages();
        }
    });
    vscode.postMessage({ type: 'ready' });
})();
