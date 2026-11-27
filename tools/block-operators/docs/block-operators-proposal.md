# Proposal: Block Operators, block-owned authoring in DA

## Problem
A block's authoring experience in DA canvas is fixed:
- **Outline** shows each block as one row, with no view of the block's internal structure.
- **Block Inspector** builds its form from the library template's `fields` metadata, plus `multi` and `options` from the
  block library. It can't express a block-specific model.

## Block operator
A **block operator** is a JS module configured for a block name. It can take over that block's authoring through
two optional **contracts**. An operator may implement both, one or neither of them:
| Contract | Surface | Host | If not implemented |
|---|---|---|---|
| `outline` | The nested area under the block's row in the Outline | DA | Today's single row |
| `inspector` | The Block Inspector panel, while the caret is in the block | Block Inspector | Today's `fields`-based form |

![Block Operators architecture](assets/block-operators-architecture.svg)

Inside a contract's surface, the operator owns everything: rendering, drag and drop, keyboard, menus, dialogs and
actions. The host provides only a mount point and `ctx`.
- Drag and drop stays inside the mount. Operators don't accept drops from outside, and the host ignores drag events
  from inside a mount.
- Operators use the nx2 styles (`nx2/styles/form.css`, `nx2/styles/buttons.css`), which the host passes as `ctx.styles`.
- `ctx.commit(html)` is the only way to change the document, and it can only replace the operator's own block.

**Selection** leverages DA's existing selection inside a block: the caret or text selection in the canvas already
identifies a position within the block. Operators only map that position to their own items (`resolve`) and back
(`locate`); no new canvas selection or highlighting is introduced.

### Interface
```js
export default {
  matches({ name, variant }) { return true; },   // optional, e.g. to handle only some variants

  create(ctx) {                                  // once per block instance, per host
    return {
      update(nextCtx) {},                        // block HTML or editability changed
      destroy() {},
      resolve(position) {},                      // position in this block → item id, or null
      locate(itemId) {},                         // item id → position in this block, or null
      describe(itemId) {},                       // optional: { label, text?, data? } for chat context
      edit() {},                                 // optional: the canvas "Edit block" action; true = handled
      outline:   { mount(container) { return { unmount() {} }; } },   // optional
      inspector: { mount(container) { return { unmount() {} }; } },   // optional
    };
  },
};
```
A **position** is `{ row, cell, textOffset? }`: `row` is the 0-based content row of the block (the block-name header row
is excluded), `cell` the 0-based cell in that row, and `textOffset` an optional character offset into that cell's text.
```ts
ctx = {
  name, variant, html,     // block identity and current HTML (EDS markup: <div class="name variant"><div><div>…)
  blockIndex,              // index of the block among the document's blocks
  editable,                // false when the doc is read-only
  styles,                  // nx2 stylesheets
  commit(html),            // replace this block (the host validates and applies)
                           //   → Promise<{ ok: true } | { ok: false, error, message }>
                           //   error: NOT_EDITABLE | STALE | INVALID_HTML | NO_EDITOR
  select(itemId),          // move the selection inside the block to an item (the host calls locate)
  onEditorSelect(cb),      // cb(itemId | null) when the selection moves inside this block (the host calls resolve)
  openPanel(nameOrId),     // DA only: open a tool-panel view, e.g. the Block Inspector → boolean
}
```
**Hooks.** `describe` and `edit` are optional hooks; when an operator doesn't implement them, DA keeps its default
behaviour. With `describe`, the item selected inside the block is added to the chat (Coworker) context next to the
block. With `edit`, the operator takes over the canvas "Edit block" action, e.g. to open the Block Inspector through
`ctx.openPanel` instead of the raw block editor.

Each host creates its own operator instance, so an operator must not rely on state shared between hosts.

### `outline` (hosted by DA)
When a block row renders and its operator implements `outline`, DA renders an expand chevron and a container under the
row, then calls `outline.mount(container)`.

### `inspector` (hosted by the Block Inspector)
When the selected block has an operator that implements `inspector`, the Block Inspector mounts it in the panel in place
of the `fields` form. Otherwise, and if the operator throws, it renders today's form.

### `commit(html)` semantics
- Rejected with `NOT_EDITABLE` when the doc is read-only, and with `STALE` when the block changed since the last
  `update`.
- Rejected with `INVALID_HTML` unless the HTML parses back to exactly one block of the same name.
- Replaces only this block, as one change; the operator then receives `update()` with the new HTML.

### Failure handling
An operator is imported only when a matching block first appears. Until it loads, if the import fails, or when it
throws, the block keeps today's behaviour.

## Configuration: the block library's `editor` sheet
The block library index (the `Blocks` row of the DA config `library` sheet) can carry an `editor` sheet, already used
for `property: multi`:
| block | property | value |
|---|---|---|
| `cards` | `multi` | *(existing)* |
| `<block name>` | `operator` | `<operator module URL>` |

- `property: operator` and the `value` column (a JS module URL or site-relative path) are new.
- Block names are normalized as for `multi`; the first row wins.
- Operators are available only to sites with a block library, and are configured per site.
