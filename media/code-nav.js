(() => {
    'use strict';
    const vscode = acquireVsCodeApi();
    const root = document.getElementById('app');
    let state = { status: 'unsupported', message: '打开 .vue 或 .js 文件开始阅读' };
    let tab = 'guide';

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
        const row = el('div', 'node-row');
        row.append(button(label || node.name, 'reveal', node.id));
        row.append(el('span', 'line-mark', `L${node.range.startLine}`));
        entry.append(row);
        const doc = docBlock(node);
        if (doc) entry.append(doc);
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
            list.append(box);
        }
        section.append(list);
        if (total > FUNCTION_LIMIT) {
            section.append(el('p', 'overflow-note',
                `还有 ${total - FUNCTION_LIMIT} 个函数，可切换到完整结构查看。`));
        }
        return section;
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
        root.replaceChildren(renderHeader());
        if (state.status !== 'ready' || !state.result) {
            const empty = el('div', 'blank-state');
            empty.append(el('div', 'blank-index', state.status === 'loading' ? '...' : '01'));
            empty.append(el('h2', '', state.status === 'loading' ? '正在梳理代码' : '从一个文件开始'));
            empty.append(el('p', '', state.message || '打开 .vue 或 .js 文件开始阅读'));
            root.append(empty);
        } else {
            root.append(renderTabs());
            root.append(tab === 'guide' ? renderGuide(state.result) : renderStructure(state.result));
        }
        vscode.postMessage({
            type: 'applied', file: state.file, status: state.status,
            publicationId: state.publicationId
        });
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
    root.addEventListener('toggle', event => {
        const details = event.target;
        if (!details.matches?.('details[data-template-id]') || !details.open || details.dataset.loaded) {
            return;
        }
        details.dataset.loaded = 'true';
        vscode.postMessage({
            type: 'pageTemplate', parentId: details.dataset.templateId,
            offset: 0, publicationId: state.publicationId
        });
    }, true);
    window.addEventListener('message', event => {
        const message = event.data;
        if (message?.type === 'state') {
            if (state.file !== message.file) tab = 'guide';
            state = message;
            render();
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
        }
    });
    vscode.postMessage({ type: 'ready' });
})();
