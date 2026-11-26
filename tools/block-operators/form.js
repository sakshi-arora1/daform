/*
 * Block operator for the form block (blocks/form).
 * Model: the adaptive form JSON in the block's `pre > code`.
 * Item id: JSON pointer of the item in the model, e.g. "/items/1" or "/items/17/items/0".
 * Contracts: resolve, locate, outline, inspector and canvas. See README.md.
 */
import {
  addSurface, commitHtml, createElement, createState, moveEntry, mountShadow, parseBlock,
  plainText, renderTree, toClassName,
} from './shared.js';

const ITEM_POINTER = /^(\/items\/\d+)+$/;
const FIELD_TYPES = [
  'text-input', 'text', 'multiline-input', 'number-input', 'email', 'tel', 'date-input', 'date',
  'drop-down', 'select', 'radio-group', 'checkbox-group', 'checkbox', 'file-input',
  'plain-text', 'heading', 'image', 'button', 'submit', 'reset', 'panel', 'captcha',
];
const SELECTED_CLASS = 'block-operator-selected';
const CANVAS_CLASS = 'block-operator-canvas';
const CANVAS_CSS = `
.${CANVAS_CLASS} .field-wrapper { cursor: pointer; }
.${CANVAS_CLASS} .field-wrapper:hover { outline: 1px dashed #3b63fb; outline-offset: 2px; }
.${CANVAS_CLASS} .${SELECTED_CLASS},
.${CANVAS_CLASS} .${SELECTED_CLASS}:hover { outline: 2px solid #3b63fb; outline-offset: 2px; }
`;

const escapeToken = (key) => String(key).replace(/~/g, '~0').replace(/\//g, '~1');

/**
 * Character ranges of every value in a valid JSON text, keyed by JSON pointer:
 * Map<pointer, { start, end }>. Only call with text that JSON.parse accepts.
 */
export function scanJson(text) {
  const ranges = new Map();
  let i = 0;
  const skipSpace = () => { while (i < text.length && /\s/.test(text[i])) i += 1; };
  const readString = () => {
    const start = i;
    i += 1;
    while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    i += 1;
    return JSON.parse(text.slice(start, i));
  };
  const readValue = (pointer) => {
    skipSpace();
    const start = i;
    const open = text[i];
    if (open === '{' || open === '[') {
      const close = open === '{' ? '}' : ']';
      let index = 0;
      i += 1;
      skipSpace();
      while (text[i] !== close) {
        let key = index;
        if (open === '{') {
          key = readString();
          skipSpace();
          i += 1; // ':'
        }
        readValue(`${pointer}/${escapeToken(key)}`);
        index += 1;
        skipSpace();
        if (text[i] === ',') i += 1;
        skipSpace();
      }
      i += 1;
    } else if (open === '"') {
      readString();
    } else {
      while (i < text.length && !/[\s,\]}]/.test(text[i])) i += 1;
    }
    ranges.set(pointer, { start, end: i });
  };
  readValue('');
  return ranges;
}

/**
 * Length of the cell text before `code`, counted like the editor does (`textOffset`):
 * whitespace-only text nodes from markup formatting don't count.
 */
function textBefore(cell, code) {
  const walker = cell.ownerDocument.createTreeWalker(cell, 4 /* NodeFilter.SHOW_TEXT */);
  let length = 0;
  for (let node = walker.nextNode(); node && !code.contains(node); node = walker.nextNode()) {
    if (node.textContent.trim()) length += node.textContent.length;
  }
  return length;
}

/** Parse the block's model. Returns null when the block has no parseable JSON. */
export function readForm(html) {
  const block = parseBlock(html);
  const code = block?.querySelector('pre code') || block?.querySelector('pre');
  if (!code) return null;
  const text = code.textContent;
  let model;
  let encoded = false;
  try {
    model = JSON.parse(text);
    if (typeof model === 'string') {
      model = JSON.parse(model);
      encoded = true;
    }
  } catch {
    return null;
  }
  if (!model || typeof model !== 'object') return null;

  let row = code;
  while (row && row.parentElement !== block) row = row.parentElement;
  const cell = [...(row?.children || [])].find((c) => c.contains(code));
  const rowIndex = [...block.children].indexOf(row);
  const cellIndex = cell ? [...row.children].indexOf(cell) : -1;
  const base = cell ? textBefore(cell, code) : 0;
  return {
    block,
    code,
    text,
    model,
    encoded,
    location: { row: rowIndex, cell: cellIndex, base },
    // Offsets into a double-encoded string don't line up with the model; skip them.
    ranges: encoded ? new Map() : scanJson(text),
  };
}

const segmentsOf = (pointer) => pointer.split('/').slice(1)
  .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));

/** The value at a JSON pointer, or undefined. */
export function getAt(model, pointer) {
  if (typeof pointer !== 'string' || !ITEM_POINTER.test(pointer)) return undefined;
  return segmentsOf(pointer).reduce((value, key) => value?.[key], model);
}

function parentOf(pointer) {
  const cut = pointer.lastIndexOf('/');
  return { list: pointer.slice(0, cut), index: Number(pointer.slice(cut + 1)) };
}

function listAt(model, listPointer) {
  return listPointer === '/items' ? model.items : getAt(model, listPointer.slice(0, -'/items'.length))?.items;
}

/** Outline nodes for the model's items; panels nest. */
export function formItems(model, base = '') {
  const items = Array.isArray(model?.items) ? model.items : [];
  return items.map((item, index) => {
    const id = `${base}/items/${index}`;
    return {
      id,
      label: plainText(item?.label?.value) || item?.name || item?.fieldType || '',
      meta: item?.fieldType || '',
      children: formItems(item, id),
    };
  });
}

function serialize(form) {
  const indent = form.text.match(/\n([ \t]+)"/)?.[1];
  let json = JSON.stringify(form.model, null, form.text.includes('\n') ? indent || 2 : undefined);
  if (form.encoded) json = JSON.stringify(json);
  form.code.textContent = json;
  return form.block.outerHTML;
}

/** Move the item at `pointer` to index `to` among its siblings: `{ html, id }` or null. */
export function moveItem(html, pointer, to) {
  const form = readForm(html);
  if (!form || !getAt(form.model, pointer)) return null;
  const { list, index } = parentOf(pointer);
  const siblings = listAt(form.model, list);
  if (!siblings || to < 0 || to >= siblings.length) return null;
  moveEntry(siblings, index, to);
  return { html: serialize(form), id: `${list}/${to}` };
}

/** Delete the item at `pointer`: block HTML or null. */
export function deleteItem(html, pointer) {
  const form = readForm(html);
  if (!form || !getAt(form.model, pointer)) return null;
  const { list, index } = parentOf(pointer);
  listAt(form.model, list).splice(index, 1);
  return serialize(form);
}

/** Apply `{ label, name, required, fieldType }` to the item at `pointer`: block HTML or null. */
export function updateItem(html, pointer, changes) {
  const form = readForm(html);
  const item = form && getAt(form.model, pointer);
  if (!item) return null;
  if (changes.label !== undefined) {
    if (item.label && typeof item.label === 'object') item.label.value = changes.label;
    else item.label = { value: changes.label };
  }
  if (changes.name !== undefined) item.name = changes.name;
  if (changes.fieldType) item.fieldType = changes.fieldType;
  if (changes.required !== undefined) {
    if (changes.required) item.required = true;
    else delete item.required;
  }
  return serialize(form);
}

/** JSON pointer of the innermost item whose JSON contains `textOffset`, or null. */
export function itemAtOffset(form, textOffset) {
  let best = null;
  form.ranges.forEach(({ start, end }, pointer) => {
    if (!ITEM_POINTER.test(pointer) || textOffset < start || textOffset >= end) return;
    if (!best || pointer.length > best.length) best = pointer;
  });
  return best;
}

/** Item pointers keyed by the field ids and class names the form block renders. */
function fieldIndex(model) {
  const byId = new Map();
  const byName = new Map();
  const walk = (items, base) => (Array.isArray(items) ? items : []).forEach((item, index) => {
    const pointer = `${base}/items/${index}`;
    if (item?.id && !byId.has(item.id)) byId.set(item.id, pointer);
    const cls = toClassName(item?.name);
    if (cls && !byName.has(cls)) byName.set(cls, pointer);
    walk(item?.items, pointer);
  });
  walk(model?.items, '');
  return { byId, byName };
}

function pointerForElement(target, blockEl, model) {
  const { byId, byName } = fieldIndex(model);
  for (let node = target; node && node !== blockEl; node = node.parentElement) {
    if (node.dataset?.id && byId.has(node.dataset.id)) return byId.get(node.dataset.id);
    if (node.classList?.contains('field-wrapper')) {
      const cls = [...node.classList].find((c) => c.startsWith('field-') && byName.has(c.slice(6)));
      if (cls) return byName.get(cls.slice(6));
    }
  }
  return null;
}

function elementForPointer(blockEl, model, pointer) {
  const item = getAt(model, pointer);
  if (!item) return null;
  if (item.id) {
    const byId = blockEl.querySelector(`.field-wrapper[data-id="${CSS.escape(item.id)}"], [data-id="${CSS.escape(item.id)}"]`);
    if (byId) return byId;
  }
  const cls = toClassName(item.name);
  return cls ? blockEl.querySelector(`.field-wrapper.field-${CSS.escape(cls)}`) : null;
}

const canvasStyles = new WeakMap();
function adoptCanvasStyles(doc) {
  let entry = canvasStyles.get(doc);
  if (!entry) {
    const style = doc.createElement('style');
    style.textContent = CANVAS_CSS;
    entry = { style, count: 0 };
    canvasStyles.set(doc, entry);
  }
  entry.count += 1;
  if (!entry.style.isConnected) doc.head.append(entry.style);
  return () => {
    entry.count -= 1;
    if (entry.count <= 0) entry.style.remove();
  };
}

function renderInspector(root, state, onCommit) {
  const doc = root.ownerDocument;
  const { ctx, selectedId } = state;
  const form = readForm(ctx.html);
  const status = createElement(doc, 'div', { class: 'bo-status', role: 'status' });
  if (!form) {
    root.replaceChildren(createElement(doc, 'div', {
      class: 'bo-empty',
      text: 'The form definition (JSON in the block\'s code) could not be parsed.',
    }));
    return;
  }

  const options = [createElement(doc, 'option', { value: '', text: 'Select a field…' })];
  const flatten = (nodes, depth) => nodes.forEach((node) => {
    options.push(createElement(doc, 'option', {
      value: node.id,
      text: `${'\u00a0\u00a0'.repeat(depth)}${node.label || '(untitled)'}${node.meta ? ` (${node.meta})` : ''}`,
      selected: node.id === selectedId,
    }));
    flatten(node.children, depth + 1);
  });
  flatten(formItems(form.model), 0);
  const picker = createElement(doc, 'select', {
    class: 'nx-input',
    ariaLabel: 'Field',
    onchange: () => {
      state.selectedId = picker.value || null;
      state.refresh();
      if (picker.value) ctx.select(picker.value);
    },
  }, options);

  const item = selectedId ? getAt(form.model, selectedId) : null;
  if (!item) {
    root.replaceChildren(createElement(doc, 'div', { class: 'bo-inspector' }, [
      picker,
      createElement(doc, 'div', { class: 'bo-empty', text: 'Select a field in the outline, the document or the preview.' }),
    ]));
    return;
  }

  const disabled = !ctx.editable;
  const label = createElement(doc, 'input', {
    class: 'nx-input', name: 'label', value: plainText(item.label?.value), disabled,
  });
  const name = createElement(doc, 'input', {
    class: 'nx-input', name: 'name', value: item.name ?? '', disabled, required: true,
  });
  const types = FIELD_TYPES.includes(item.fieldType) || !item.fieldType
    ? FIELD_TYPES : [item.fieldType, ...FIELD_TYPES];
  const fieldType = createElement(doc, 'select', { class: 'nx-input', name: 'fieldType', disabled }, types
    .map((type) => createElement(doc, 'option', { value: type, text: type, selected: type === item.fieldType })));
  const required = createElement(doc, 'input', {
    type: 'checkbox', name: 'required', checked: item.required === true, disabled,
  });

  const field = (text, control) => createElement(doc, 'label', { class: 'nx-form-field' }, [text, control]);
  const formEl = createElement(doc, 'form', {
    class: 'bo-inspector',
    onsubmit: (e) => {
      e.preventDefault();
      onCommit(updateItem(ctx.html, selectedId, {
        // Keep rich-text labels untouched unless the text actually changed.
        label: label.value === plainText(item.label?.value) ? undefined : label.value,
        name: name.value.trim(),
        fieldType: fieldType.value,
        required: required.checked,
      }), status);
    },
  }, [
    picker,
    field('Label', label),
    field('Name', name),
    field('Type', fieldType),
    createElement(doc, 'label', { class: 'nx-checkbox bo-check' }, [required, 'Required']),
    createElement(doc, 'div', { class: 'bo-actions' }, [
      createElement(doc, 'button', {
        type: 'submit', class: 'nx-btn-primary', text: 'Apply', disabled,
      }),
      createElement(doc, 'button', {
        type: 'reset', class: 'nx-action-btn', text: 'Reset', disabled,
      }),
    ]),
    status,
  ]);
  root.replaceChildren(formEl);
}

export default {
  matches: () => true,

  create(initialCtx) {
    const state = createState(initialCtx);
    const form = () => readForm(state.ctx.html);

    return {
      update(nextCtx) {
        state.ctx = nextCtx;
        const current = form();
        if (state.selectedId && !getAt(current?.model, state.selectedId)) state.selectedId = null;
        state.refresh();
      },

      destroy() {
        state.destroy();
      },

      resolve(position) {
        const current = form();
        if (!current || !position || !Number.isInteger(position.textOffset)) return null;
        const { row, cell, base } = current.location;
        if (position.row !== row || position.cell !== cell) return null;
        return itemAtOffset(current, position.textOffset - base);
      },

      locate(itemId) {
        const current = form();
        const range = current?.ranges.get(itemId);
        if (!range || !ITEM_POINTER.test(itemId)) return null;
        const { row, cell, base } = current.location;
        return { row, cell, textOffset: base + range.start };
      },

      outline: {
        mount(container) {
          const { root, remove } = mountShadow(container, state.ctx.styles);
          let focusId = null;
          let status;

          const commit = async (html, nextId) => {
            if (!html) return;
            const previous = state.selectedId;
            // Set before committing: the host calls update() (and so render) once applied.
            state.selectedId = nextId;
            focusId = nextId;
            const result = await commitHtml(state.ctx, html, status);
            if (!result.ok) {
              state.selectedId = previous;
              focusId = null;
            }
          };

          const render = () => {
            const current = form();
            status = renderTree(root, formItems(current?.model), {
              selectedId: state.selectedId,
              focusId,
              editable: state.ctx.editable && !!current,
              onSelect: (id) => {
                state.selectedId = id;
                focusId = id;
                state.refresh();
                state.ctx.select(id);
              },
              onMove: (id, to) => {
                const moved = moveItem(state.ctx.html, id, to);
                if (moved) commit(moved.html, moved.id);
              },
              onDelete: (id) => commit(deleteItem(state.ctx.html, id), null),
            });
            if (!current) status.textContent = 'The form definition could not be parsed.';
            focusId = null;
          };
          return addSurface(state, render, remove);
        },
      },

      inspector: {
        mount(container) {
          const { root, remove } = mountShadow(container, state.ctx.styles);
          let lastKey = null;
          const render = () => {
            // Don't wipe in-progress edits when nothing this panel shows has changed.
            const key = `${state.selectedId}\n${state.ctx.editable}\n${state.ctx.html}`;
            if (key === lastKey) return;
            lastKey = key;
            renderInspector(root, state, async (html, status) => {
              if (html) await commitHtml(state.ctx, html, status);
            });
          };
          return addSurface(state, render, remove);
        },
      },

      canvas: {
        mount(blockEl) {
          const doc = blockEl.ownerDocument;
          const releaseStyles = adoptCanvasStyles(doc);
          blockEl.classList.add(CANVAS_CLASS);
          let shown = null;

          const render = () => {
            blockEl.querySelectorAll(`.${SELECTED_CLASS}`).forEach((n) => n.classList.remove(SELECTED_CLASS));
            const target = state.selectedId
              && elementForPointer(blockEl, form()?.model, state.selectedId);
            target?.classList.add(SELECTED_CLASS);
            if (target && shown !== state.selectedId) target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            shown = state.selectedId;
          };

          const pointerFor = (event) => pointerForElement(event.target, blockEl, form()?.model);
          // Keep quick-edit from selecting the whole block; ctx.select moves the selection instead.
          const onMouseDown = (event) => {
            if (pointerFor(event)) event.stopPropagation();
          };
          const onClick = (event) => {
            const pointer = pointerFor(event);
            if (!pointer) return;
            if (event.target.closest('button, a, [type="submit"]')) event.preventDefault();
            event.stopPropagation();
            state.selectedId = pointer;
            state.refresh();
            state.ctx.select(pointer);
          };
          blockEl.addEventListener('mousedown', onMouseDown);
          blockEl.addEventListener('click', onClick);

          return addSurface(state, render, () => {
            blockEl.removeEventListener('mousedown', onMouseDown);
            blockEl.removeEventListener('click', onClick);
            blockEl.querySelectorAll(`.${SELECTED_CLASS}`).forEach((n) => n.classList.remove(SELECTED_CLASS));
            blockEl.classList.remove(CANVAS_CLASS);
            releaseStyles();
          });
        },
      },
    };
  },
};
