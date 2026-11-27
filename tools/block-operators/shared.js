/*
 * Helpers shared by the block operators in this folder.
 * See README.md for the operator interface and the contracts.
 */
import { registerOutline } from '../../scripts/block-operator-sync.js';

const TREE_CSS = `
& { display: block; font: inherit; padding-block: 4px; }
.bo-tree, .bo-tree ul { list-style: none; margin: 0; padding: 0; }
.bo-tree ul {
  margin-inline-start: 11px; padding-inline-start: 18px;
  border-inline-start: 1px solid var(--s2-gray-300, #dadada);
}
.bo-node, .bo-head {
  display: flex; align-items: baseline; gap: 8px; min-height: 30px; padding: 3px 8px;
  border-radius: 8px; box-sizing: border-box; user-select: none;
}
.bo-node { cursor: pointer; }
.bo-node:hover { background: var(--s2-gray-100, #f3f3f3); }
.bo-node:focus-visible { outline: 2px solid var(--s2-blue-800, #3b63fb); outline-offset: -2px; }
.bo-node.is-selected { background: var(--s2-blue-100, #e5f0fe); }
.bo-node.is-drop-before { box-shadow: inset 0 2px 0 var(--s2-blue-800, #3b63fb); }
.bo-node.is-drop-after { box-shadow: inset 0 -2px 0 var(--s2-blue-800, #3b63fb); }
.bo-head { background: var(--s2-gray-75, #f8f8f8); }
.bo-head .bo-label { color: var(--s2-blue-900, #3b63fb); }
.bo-grip {
  align-self: center; width: 12px; flex: none; cursor: grab; letter-spacing: -2px;
  color: var(--s2-gray-400, #c6c6c6); font-size: 12px; line-height: 1;
}
.bo-type { flex: none; color: var(--s2-gray-700, #6d6d6d); font-size: 0.85em; }
.bo-label {
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--s2-gray-900, #222); font-size: 1.05em;
}
.bo-meta { margin-inline-start: auto; color: var(--s2-gray-700, #6d6d6d); font-size: 0.85em; }
.action-btn { align-self: center; margin-inline-start: auto; opacity: 0; }
.bo-meta + .action-btn { margin-inline-start: 0; }
.action-btn svg.icon { display: block; width: 16px; height: 16px; }
.bo-node.is-selected .action-btn, .action-btn:focus-visible,
.bo-node:hover .action-btn, .bo-node:focus-within .action-btn { opacity: 1; }
.bo-empty, .bo-status { color: var(--s2-gray-700, #6d6d6d); padding: 4px; font-size: 0.9em; }
.bo-status:empty { display: none; }
.bo-status.is-error { color: var(--s2-red-900, #d31510); }
.bo-inspector { display: flex; flex-direction: column; gap: 12px; }
.bo-inspector label { display: flex; flex-direction: column; gap: 4px; }
.bo-inspector .bo-check { flex-direction: row; align-items: center; gap: 8px; }
.bo-actions { display: flex; gap: 8px; }
`;

const DRAG_TYPE = 'application/x-block-operator-item';
const DELETE_ICON_SRC = '/img/icons/s2-icon-delete-20-n.svg';

/** Parse a block's EDS markup into its block element (detached), or null. */
export function parseBlock(html) {
  if (typeof html !== 'string' || !html.trim()) return null;
  const template = document.createElement('template');
  template.innerHTML = html.trim();
  const block = template.content.firstElementChild;
  return block?.tagName === 'DIV' ? block : null;
}

/** Plain text of an HTML fragment (labels can carry rich text). */
export function plainText(html) {
  if (html == null) return '';
  const template = document.createElement('template');
  template.innerHTML = String(html);
  return template.content.textContent.replace(/\s+/g, ' ').trim();
}

/** Move an array entry in place; returns the array. */
export function moveEntry(list, from, to) {
  const [entry] = list.splice(from, 1);
  list.splice(to, 0, entry);
  return list;
}

/** Create an element. `aria*`, `role` and `data-*` keys become attributes, others properties. */
export function createElement(doc, tag, props = {}, children = []) {
  const node = doc.createElement(tag);
  Object.entries(props).forEach(([key, value]) => {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'role' || key.startsWith('data-')) node.setAttribute(key, value);
    else if (key.startsWith('aria')) node.setAttribute(`aria-${key.slice(4).toLowerCase()}`, value);
    else node[key] = value;
  });
  node.append(...children);
  return node;
}

// Operator sheets added to a host root (Document or ShadowRoot), with a use count each.
const addedSheets = new WeakMap();

function adoptSheet(rootNode, cssText) {
  const view = (rootNode.ownerDocument || rootNode).defaultView;
  const byCss = addedSheets.get(rootNode) ?? new Map();
  addedSheets.set(rootNode, byCss);
  let entry = byCss.get(cssText);
  if (!entry) {
    const sheet = new view.CSSStyleSheet();
    // Scope every rule to the operator's mount, so nothing leaks into the host surface.
    sheet.replaceSync(`.block-operator { ${cssText} }`);
    entry = { sheet, count: 0 };
    byCss.set(cssText, entry);
    rootNode.adoptedStyleSheets = [...rootNode.adoptedStyleSheets, sheet];
  }
  entry.count += 1;
  return () => {
    entry.count -= 1;
    if (entry.count > 0) return;
    byCss.delete(cssText);
    rootNode.adoptedStyleSheets = rootNode.adoptedStyleSheets.filter((s) => s !== entry.sheet);
  };
}

/**
 * Render directly into `container` (no shadow root): the host surface's own sheets (nx2 form and
 * buttons) apply as is, and the operators' CSS (`css` strings plus the tree CSS) is added once to
 * the host's root, scoped under `.block-operator`. Returns `{ root, remove }`; `root` is the
 * operator's element.
 */
export function mountInto(container, css = []) {
  const doc = container.ownerDocument;
  const root = doc.createElement('div');
  root.className = 'block-operator';
  container.append(root);
  const rootNode = container.getRootNode();
  const releases = 'adoptedStyleSheets' in rootNode
    ? [TREE_CSS, ...css].map((text) => adoptSheet(rootNode, text)) : [];
  return {
    root,
    remove: () => {
      root.remove();
      releases.forEach((release) => release());
    },
  };
}

/** Commit through ctx; reports a failure in `status` (an element) and returns the result. */
export async function commitHtml(ctx, html, status) {
  let result;
  if (!ctx.editable) {
    result = { ok: false, error: 'NOT_EDITABLE', message: 'The document is read-only.' };
  } else {
    try {
      result = await ctx.commit(html);
    } catch (error) {
      result = { ok: false, error: 'COMMIT_FAILED', message: error?.message };
    }
  }
  result ??= { ok: false, error: 'COMMIT_FAILED' };
  if (status?.isConnected) {
    status.textContent = result.ok ? '' : `Could not save: ${result.message || result.error}`;
    status.classList.toggle('is-error', !result.ok);
  }
  return result;
}

/**
 * Render an outline tree into `root` (the operator's element).
 * nodes: [{ id, label, meta?, children? }]. Reordering is limited to siblings.
 * opts: { selectedId, focusId, editable, onSelect(id), onMove(id, toIndex), onDelete(id) }
 * Returns the status element.
 */
export function renderTree(root, nodes, opts) {
  const doc = root.ownerDocument;
  const {
    selectedId, focusId, editable, onSelect, onMove, onDelete, header,
  } = opts;
  const siblingsOf = new Map();
  let dragging = null;

  const clearDrop = () => root.querySelectorAll('.is-drop-before, .is-drop-after')
    .forEach((n) => n.classList.remove('is-drop-before', 'is-drop-after'));

  const dropIndex = (event, row) => {
    const target = row.dataset.id;
    if (dragging == null || dragging === target) return null;
    const siblings = siblingsOf.get(dragging);
    if (siblings !== siblingsOf.get(target)) return null;
    const rect = row.getBoundingClientRect();
    const after = event.clientY > rect.top + rect.height / 2;
    const from = siblings.indexOf(dragging);
    let to = siblings.indexOf(target) + (after ? 1 : 0);
    if (to > from) to -= 1;
    return { to, after, changed: to !== from };
  };

  const build = (list) => {
    const ids = list.map((n) => n.id);
    return list.map((node) => {
      siblingsOf.set(node.id, ids);
      const label = node.label || '(untitled)';
      const selected = node.id === selectedId;
      const row = createElement(doc, 'div', {
        class: `bo-node${selected ? ' is-selected' : ''}`,
        role: 'treeitem',
        tabIndex: 0,
        draggable: !!editable,
        'data-id': node.id,
        ariaSelected: String(selected),
      }, [
        createElement(doc, 'span', { class: 'bo-grip', text: editable ? '⋮⋮' : '', ariaHidden: 'true' }),
        node.type ? createElement(doc, 'span', { class: 'bo-type', text: node.type }) : '',
        createElement(doc, 'span', { class: 'bo-label', text: label, title: label }),
        node.meta ? createElement(doc, 'span', { class: 'bo-meta', text: node.meta }) : '',
      ]);
      if (editable) {
        const button = createElement(doc, 'button', {
          type: 'button',
          class: 'nx-action-btn-icon nx-btn-sm action-btn delete-btn',
          title: `Delete ${label}`,
          ariaLabel: `Delete ${label}`,
          tabIndex: -1,
          draggable: false,
          onpointerdown: (e) => e.stopPropagation(),
          onclick: (e) => { e.stopPropagation(); onDelete(node.id); },
        });
        // Same markup as DA's outline delete button; the outline renders inside da.live.
        button.innerHTML = `<svg aria-hidden="true" class="icon" viewBox="0 0 20 20"><use href="${DELETE_ICON_SRC}#icon"></use></svg>`;
        row.append(button);
      }
      row.addEventListener('click', () => onSelect(node.id));
      row.addEventListener('keydown', (e) => {
        const index = ids.indexOf(node.id);
        if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
          e.preventDefault();
          const to = index + (e.key === 'ArrowUp' ? -1 : 1);
          if (editable && to >= 0 && to < ids.length) onMove(node.id, to);
        } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault();
          const rows = [...root.querySelectorAll('.bo-node')];
          rows[rows.indexOf(row) + (e.key === 'ArrowUp' ? -1 : 1)]?.focus();
        } else if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(node.id);
        } else if ((e.key === 'Delete' || e.key === 'Backspace') && editable) {
          e.preventDefault();
          onDelete(node.id);
        }
      });
      row.addEventListener('dragstart', (e) => {
        e.stopPropagation();
        dragging = node.id;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData(DRAG_TYPE, node.id);
      });
      row.addEventListener('dragend', (e) => {
        e.stopPropagation();
        dragging = null;
        clearDrop();
      });
      row.addEventListener('dragover', (e) => {
        e.stopPropagation();
        const drop = dropIndex(e, row);
        clearDrop();
        if (!drop) return;
        e.preventDefault();
        row.classList.add(drop.after ? 'is-drop-after' : 'is-drop-before');
      });
      row.addEventListener('drop', (e) => {
        e.stopPropagation();
        const drop = dropIndex(e, row);
        const id = dragging;
        dragging = null;
        clearDrop();
        if (!drop) return;
        e.preventDefault();
        if (drop.changed) onMove(id, drop.to);
      });
      const children = node.children?.length
        ? [createElement(doc, 'ul', { role: 'group' }, build(node.children))]
        : [];
      return createElement(doc, 'li', { role: 'none' }, [row, ...children]);
    });
  };

  const tree = nodes.length
    ? createElement(doc, 'ul', { class: 'bo-tree', role: 'tree' }, build(nodes))
    : createElement(doc, 'div', { class: 'bo-empty', text: 'No items' });
  const status = createElement(doc, 'div', { class: 'bo-status', role: 'status' });
  // Optional heading row for the whole block, e.g. `{ type: 'Form', label: 'Event registration' }`.
  const head = header ? createElement(doc, 'div', { class: 'bo-head' }, [
    header.type ? createElement(doc, 'span', { class: 'bo-type', text: header.type }) : '',
    createElement(doc, 'span', { class: 'bo-label', text: header.label || '', title: header.label || '' }),
  ]) : '';
  root.replaceChildren(...[head, tree, status].filter(Boolean));
  if (focusId != null) root.querySelector(`[data-id="${CSS.escape(focusId)}"]`)?.focus();
  return status;
}

/**
 * Per-instance plumbing: the latest ctx, the selected item, and re-rendering every mounted
 * surface when either changes. In the da.live page (the outline host), the selection is also
 * synced with the Block Inspector and the Layout view (scripts/block-operator-sync.js); the
 * Block Inspector host (`ctx.surface === 'inspector'`) syncs its own instances.
 * `hasItem(itemId, ctx)` tells whether an item id belongs to this block (its current ctx).
 */
// After this surface moves the caret to an item, the editor reports the caret back through
// onEditorSelect; within this window that report is an echo, not a new selection.
export const ECHO_MS = 1000;

export function createState(ctx, { hasItem = () => false, now = () => Date.now() } = {}) {
  const state = {
    ctx,
    selectedId: null,
    renders: new Set(),
    sync: null,
    echoUntil: 0,
    refresh() { state.renders.forEach((render) => render()); },
    // Move the caret without treating the editor's report of it as a new selection.
    moveCaret(itemId) {
      if (itemId == null) return;
      state.echoUntil = now() + ECHO_MS;
      state.ctx.select?.(itemId);
    },
    /** A selection made in this surface: move the editor caret and tell the other surfaces. */
    select(itemId) {
      state.selectedId = itemId ?? null;
      state.refresh();
      state.moveCaret(state.selectedId);
      state.sync?.publish(state.selectedId);
    },
    destroy() {
      state.renders.clear();
      state.unsubscribe?.();
      state.sync?.unregister();
    },
  };
  state.unsubscribe = ctx.onEditorSelect?.((itemId) => {
    const next = itemId ?? null;
    if (next === state.selectedId || now() < state.echoUntil) return;
    state.selectedId = next;
    state.refresh();
    state.sync?.publish(next);
  });
  if (ctx.surface !== 'inspector') {
    state.sync = registerOutline({
      block: () => state.ctx.name,
      blockIndex: () => state.ctx.blockIndex,
      hasItem: (itemId) => hasItem(itemId, state.ctx),
      // A selection received from another surface: show it and move the caret, but never
      // publish in response (the sender and the relay already told everyone).
      onSelect: (itemId) => {
        if (itemId === state.selectedId) return;
        state.selectedId = itemId;
        state.refresh();
        state.moveCaret(itemId);
      },
    });
  }
  return state;
}

/** Register a surface render function; returns its `{ unmount }` handle. */
export function addSurface(state, render, cleanup = () => {}) {
  state.renders.add(render);
  render();
  return {
    unmount() {
      state.renders.delete(render);
      cleanup();
    },
  };
}
