/*
 * Block operator for the accordion block (blocks/accordion).
 * Contracts: resolve, locate and outline. Item id = the row index as a string ("0", "1", …).
 * See README.md.
 */
import {
  addSurface, commitHtml, createState, moveEntry, mountShadow, parseBlock, renderTree,
} from './shared.js';

function rowsOf(block) {
  return block ? [...block.children].filter((row) => row.tagName === 'DIV') : [];
}

/** Outline nodes: one per accordion row, labelled with the text of its first cell. */
export function accordionItems(html) {
  return rowsOf(parseBlock(html)).map((row, index) => ({
    id: String(index),
    label: (row.children[0]?.textContent || '').replace(/\s+/g, ' ').trim(),
  }));
}

/** Block HTML with row `from` moved to index `to`, or null. */
export function moveRow(html, from, to) {
  const block = parseBlock(html);
  const rows = rowsOf(block);
  if (!rows[from] || to < 0 || to >= rows.length) return null;
  moveEntry(rows, from, to).forEach((row) => block.append(row));
  return block.outerHTML;
}

/** Block HTML without row `index`, or null. */
export function deleteRow(html, index) {
  const block = parseBlock(html);
  const row = rowsOf(block)[index];
  if (!row) return null;
  row.remove();
  return block.outerHTML;
}

const toIndex = (itemId) => (/^\d+$/.test(String(itemId)) ? Number(itemId) : -1);

export default {
  matches: () => true,

  create(initialCtx) {
    const rowCount = (ctx) => rowsOf(parseBlock(ctx.html)).length;
    const state = createState(initialCtx, {
      hasItem: (itemId, ctx) => toIndex(itemId) >= 0 && toIndex(itemId) < rowCount(ctx),
    });
    const count = () => rowCount(state.ctx);

    return {
      update(nextCtx) {
        state.ctx = nextCtx;
        const selected = toIndex(state.selectedId);
        if (state.selectedId != null && selected >= count()) state.selectedId = null;
        state.refresh();
      },

      destroy() {
        state.destroy();
      },

      resolve(position) {
        const row = position?.row;
        return Number.isInteger(row) && row >= 0 && row < count() ? String(row) : null;
      },

      locate(itemId) {
        const row = toIndex(itemId);
        return row >= 0 && row < count() ? { row, cell: 0 } : null;
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
            status = renderTree(root, accordionItems(state.ctx.html), {
              selectedId: state.selectedId,
              focusId,
              editable: state.ctx.editable,
              onSelect: (id) => {
                focusId = id;
                state.select(id);
              },
              onMove: (id, to) => commit(moveRow(state.ctx.html, toIndex(id), to), String(to)),
              onDelete: (id) => commit(deleteRow(state.ctx.html, toIndex(id)), null),
            });
            focusId = null;
          };
          return addSurface(state, render, remove);
        },
      },
    };
  },
};
