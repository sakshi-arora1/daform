/*
 * Helpers shared by the block operators in this folder.
 * See README.md for the operator interface and the contracts.
 */

const TREE_CSS = `
:host { display: block; font: inherit; }
.bo-tree, .bo-tree ul { list-style: none; margin: 0; padding: 0; }
.bo-tree ul { padding-inline-start: 16px; }
.bo-node {
  display: flex; align-items: center; gap: 6px; min-height: 28px; padding: 0 4px;
  border-radius: 4px; cursor: pointer; user-select: none;
}
.bo-node:hover { background: var(--s2-gray-100, #f3f3f3); }
.bo-node:focus-visible { outline: 2px solid var(--s2-blue-800, #3b63fb); outline-offset: -2px; }
.bo-node.is-selected { background: var(--s2-blue-100, #e5f0fe); }
.bo-node.is-drop-before { box-shadow: inset 0 2px 0 var(--s2-blue-800, #3b63fb); }
.bo-node.is-drop-after { box-shadow: inset 0 -2px 0 var(--s2-blue-800, #3b63fb); }
.bo-grip { cursor: grab; color: var(--s2-gray-600, #8f8f8f); }
.bo-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bo-meta { color: var(--s2-gray-700, #6d6d6d); font-size: 0.85em; }
.bo-delete { visibility: hidden; }
.bo-node:hover .bo-delete, .bo-node:focus-within .bo-delete, .bo-node.is-selected .bo-delete {
  visibility: visible;
}
.bo-empty, .bo-status { color: var(--s2-gray-700, #6d6d6d); padding: 4px; font-size: 0.9em; }
.bo-status:empty { display: none; }
.bo-status.is-error { color: var(--s2-red-900, #d31510); }
.bo-inspector { display: flex; flex-direction: column; gap: 12px; }
.bo-inspector label { display: flex; flex-direction: column; gap: 4px; }
.bo-inspector .bo-check { flex-direction: row; align-items: center; gap: 8px; }
.bo-actions { display: flex; gap: 8px; }
`;

const DRAG_TYPE = 'application/x-block-operator-item';

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

/** Same class-name normalisation as aem.js `toClassName`. */
export function toClassName(name) {
  return typeof name === 'string'
    ? name.toLowerCase().replace(/[^0-9a-z]/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
    : '';
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

/**
 * Open a shadow root inside `container` that adopts the host's nx2 sheets (`ctx.styles`)
 * plus the operators' own sheet. Returns `{ root, remove }`.
 */
export function mountShadow(container, styles = []) {
  const doc = container.ownerDocument;
  const view = doc.defaultView;
  const host = doc.createElement('div');
  host.className = 'block-operator';
  container.append(host);
  const root = host.attachShadow({ mode: 'open' });
  const own = new view.CSSStyleSheet();
  own.replaceSync(TREE_CSS);
  // Sheets constructed in another document can't be adopted here; skip them.
  const adoptable = (styles || []).filter((sheet) => sheet instanceof view.CSSStyleSheet);
  root.adoptedStyleSheets = [...adoptable, own];
  return { root, remove: () => host.remove() };
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
 * Render an outline tree into `root` (a shadow root or element).
 * nodes: [{ id, label, meta?, children? }]. Reordering is limited to siblings.
 * opts: { selectedId, focusId, editable, onSelect(id), onMove(id, toIndex), onDelete(id) }
 * Returns the status element.
 */
export function renderTree(root, nodes, opts) {
  const doc = root.ownerDocument || root;
  const {
    selectedId, focusId, editable, onSelect, onMove, onDelete,
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
        createElement(doc, 'span', { class: 'bo-label', text: label, title: label }),
        node.meta ? createElement(doc, 'span', { class: 'bo-meta', text: node.meta }) : '',
      ]);
      if (editable) {
        row.append(createElement(doc, 'button', {
          type: 'button',
          class: 'nx-action-btn-quiet nx-btn-sm bo-delete',
          text: '✕',
          title: `Delete ${label}`,
          ariaLabel: `Delete ${label}`,
          tabIndex: -1,
          draggable: false,
          onclick: (e) => { e.stopPropagation(); onDelete(node.id); },
        }));
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
  root.replaceChildren(tree, status);
  if (focusId != null) root.querySelector(`[data-id="${CSS.escape(focusId)}"]`)?.focus();
  return status;
}

/**
 * Per-instance plumbing: the latest ctx, the selected item, and re-rendering every mounted
 * surface when either changes. Subscribes to editor selection once, for the instance's life.
 */
export function createState(ctx) {
  const state = {
    ctx,
    selectedId: null,
    renders: new Set(),
    refresh() { state.renders.forEach((render) => render()); },
    destroy() {
      state.renders.clear();
      state.unsubscribe?.();
    },
  };
  state.unsubscribe = ctx.onEditorSelect?.((itemId) => {
    const next = itemId ?? null;
    if (next === state.selectedId) return;
    state.selectedId = next;
    state.refresh();
  });
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
