/*
 * Block operator for the form block (blocks/form).
 * Model: the adaptive form JSON in the block's `pre > code`.
 * Item id: the item's `id`, else its `name`, else its JSON pointer (`/items/17/items/0`), as
 * `formItemIds` (scripts/block-operator-sync.js) assigns them; blocks/form tags the Layout view
 * with the same ids. Internally items are addressed by JSON pointer.
 * Contracts: resolve, locate, outline and inspector. See README.md.
 */
import {
  addSurface, commitHtml, createState, moveEntry, mountInto, parseBlock, plainText, renderTree,
} from './shared.js';
import { componentTitle, createModelInspector, INSPECTOR_CSS } from './form-inspector.js';
import { formItemIds } from '../../scripts/block-operator-sync.js';

const ITEM_POINTER = /^(\/items\/\d+)+$/;

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

/** Outline nodes for the model's items, with their stable ids; panels nest. */
export function formItems(model, ids = formItemIds(model), base = '') {
  const items = Array.isArray(model?.items) ? model.items : [];
  return items.map((item, index) => {
    const pointer = `${base}/items/${index}`;
    return {
      id: ids.idOf.get(pointer),
      label: plainText(item?.label?.value) || item?.name || item?.fieldType || '',
      type: componentTitle(item),
      children: formItems(item, ids, pointer),
    };
  });
}

/** Stable id of the item at `pointer` in a block's HTML, or null. */
export function idAt(html, pointer) {
  return formItemIds(readForm(html)?.model).idOf.get(pointer) ?? null;
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

/** Replace the item at `pointer` with `item`: block HTML or null. */
export function replaceItem(html, pointer, item) {
  const form = readForm(html);
  if (!form || !getAt(form.model, pointer) || !item || typeof item !== 'object') return null;
  const { list, index } = parentOf(pointer);
  listAt(form.model, list)[index] = item;
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

// Title of the Block Inspector row in the DA config `library` sheet, opened by the Layout pencil.
export const INSPECTOR_PANEL = 'Block Inspector';

const MAX_CHAT_TEXT = 4000;

/** Coworker chat context for item `itemId` at `pointer`: label, summary and JSON, or null. */
export function chatContextFor(model, pointer, itemId) {
  const item = pointer && getAt(model, pointer);
  if (!item || typeof item !== 'object') return null;
  const label = plainText(item.label?.value) || item.name || item.fieldType || pointer;
  const facts = [
    item.fieldType && `type ${item.fieldType}`,
    item.name && `name ${item.name}`,
    item.required && 'required',
  ].filter(Boolean);
  const innerText = [
    `Selected form field "${label}" (id ${itemId})${facts.length ? `: ${facts.join(', ')}` : ''}.`,
    JSON.stringify(item),
  ].join('\n').slice(0, MAX_CHAT_TEXT);
  return { label: `form: ${label}`, innerText, pinnable: true };
}

export default {
  matches: () => true,

  create(initialCtx) {
    const pointerIn = (ctx, itemId) => formItemIds(readForm(ctx.html)?.model).pointerOf.get(itemId);
    const state = createState(initialCtx, { hasItem: (itemId, ctx) => !!pointerIn(ctx, itemId) });
    const form = () => readForm(state.ctx.html);
    const pointerOf = (itemId) => pointerIn(state.ctx, itemId) ?? null;

    // Coworker context: the field under the caret (DA host only; no-op without setChatContext).
    let chatKey = null;
    const syncChat = (itemId) => {
      const { setChatContext } = state.ctx;
      if (typeof setChatContext !== 'function') return;
      const current = itemId == null ? null : form();
      const item = current && chatContextFor(current.model, pointerOf(itemId), itemId);
      const key = item ? JSON.stringify(item) : null;
      if (key === chatKey) return;
      chatKey = key;
      setChatContext(item);
    };
    let selectedItem = null;
    const unsubscribeChat = initialCtx.onEditorSelect?.((itemId) => {
      selectedItem = itemId;
      syncChat(itemId);
    });

    return {
      update(nextCtx) {
        state.ctx = nextCtx;
        if (state.selectedId != null && pointerOf(state.selectedId) == null) {
          state.selectedId = null;
        }
        state.refresh();
        syncChat(selectedItem);
      },

      destroy() {
        unsubscribeChat?.();
        state.destroy();
      },

      resolve(position) {
        const current = form();
        if (!current || !position || !Number.isInteger(position.textOffset)) return null;
        const { row, cell, base } = current.location;
        if (position.row !== row || position.cell !== cell) return null;
        const pointer = itemAtOffset(current, position.textOffset - base);
        return pointer ? formItemIds(current.model).idOf.get(pointer) ?? null : null;
      },

      locate(itemId) {
        const current = form();
        const pointer = formItemIds(current?.model).pointerOf.get(itemId);
        const range = pointer && current.ranges.get(pointer);
        if (!range) return null;
        const { row, cell, base } = current.location;
        return { row, cell, textOffset: base + range.start };
      },

      // Layout view pencil: edit the form in the Block Inspector instead of as raw JSON.
      edit() {
        return typeof state.ctx.openPanel === 'function' && state.ctx.openPanel(INSPECTOR_PANEL) === true;
      },

      outline: {
        mount(container) {
          const { root, remove } = mountInto(container);
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
            const model = current?.model;
            status = renderTree(root, formItems(model), {
              header: model && {
                type: 'Form',
                label: plainText(model.title || model.label?.value) || model.name || '',
              },
              selectedId: state.selectedId,
              focusId,
              editable: state.ctx.editable && !!current,
              onSelect: (id) => {
                focusId = id;
                state.select(id);
              },
              onMove: (id, to) => {
                const moved = moveItem(state.ctx.html, pointerOf(id), to);
                if (moved) commit(moved.html, idAt(moved.html, moved.id));
              },
              onDelete: (id) => commit(deleteItem(state.ctx.html, pointerOf(id)), null),
            });
            if (!current) status.textContent = 'The form definition could not be parsed.';
            focusId = null;
          };
          return addSurface(state, render, remove);
        },
      },

      inspector: {
        mount(container) {
          const { root, remove } = mountInto(container, [INSPECTOR_CSS]);
          const inspector = createModelInspector(root, {
            getItem: () => {
              const pointer = state.selectedId != null ? pointerOf(state.selectedId) : null;
              const item = pointer && getAt(form()?.model, pointer);
              return item ? { item, pointer } : null;
            },
            editable: () => state.ctx.editable,
            commitItem: async (pointer, item) => {
              const html = replaceItem(state.ctx.html, pointer, item);
              if (!html) {
                return { ok: false, error: 'STALE', message: 'The field no longer exists.' };
              }
              // Renaming the item changes its id; keep it selected under the new one.
              const previous = state.selectedId;
              state.selectedId = idAt(html, pointer);
              const result = await commitHtml(state.ctx, html);
              if (!result.ok) state.selectedId = previous;
              else if (state.selectedId !== previous) state.sync?.publish(state.selectedId);
              return result;
            },
          });
          return addSurface(state, inspector.render, remove);
        },
      },
    };
  },
};
