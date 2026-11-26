# Proposal: Block Operators, block-owned authoring in DA

## Problem
A block's authoring experience in DA canvas is fixed:
- **Outline** (`da-live/blocks/canvas/ew-page-outline/ew-page-outline.js`) shows each block as one row
  (`parseSections()` in `editor-utils/editor-utils.js`), with no view of the block's internal structure.
- **Block Inspector** (`adobe-rnd/ew-extensions/tools/block-editor`) builds its form from the library template's
  `fields` metadata, plus `multi` and `options` from the block library. It can't express a block-specific model.
- **Canvas selection**: a click in the WYSIWYG canvas sends `NODE_SELECT`, and `handleNodeSelect`
  (`ew-editor-wysiwyg/utils/handlers.js`) turns it into a ProseMirror `NodeSelection`. Nothing maps it to a block's
  own items.

## Block operator
A **block operator** is a JS module configured for a block name. It can take over that block's authoring through
three optional **contracts**. An operator may implement all, some or none of them:
| Contract | Surface | Host | If not implemented |
|---|---|---|---|
| `outline` | The nested area under the block's row in the Outline | DA | Today's single row |
| `inspector` | The Block Inspector panel, while the caret is in the block | Block Inspector extension | Today's `fields`-based form |
| `canvas` | The rendered block in the WYSIWYG preview: overlays and in-canvas gestures | quick-edit in the preview page | Today's quick-edit editing |

![Block Operators architecture](assets/block-operators-architecture.svg)

Inside a contract's surface, the operator owns everything: rendering, drag and drop, keyboard, menus, dialogs, actions
and gestures. The host provides only a mount point and `ctx`.
- Drag and drop stays inside the mount. Operators don't accept drops from outside, and DA's outline drag/drop handlers
  ignore events from inside a mount.
- In the outline and the Block Inspector, operators use the nx2 styles (`nx2/styles/form.css`, `nx2/styles/buttons.css`).
  Both already load these as constructable sheets (`getSheet` in `ew-page-outline.js` and in `block-editor.js`), and pass
  them as `ctx.styles`.
- `ctx.commit(html)` is the only way to change the document, and it can only replace the operator's own block.

### Interface
```js
export default {
  matches({ name, variant }) { return true; },   // optional, e.g. to handle only some variants

  create(ctx) {                                  // once per block instance, per host
    return {
      update(nextCtx) {},                        // block HTML or editability changed
      destroy() {},
      resolve(position) {},                      // editor position in this block → item id, or null
      locate(itemId) {},                         // item id → editor position, or null
      outline:   { mount(container) { return { unmount() {} }; } },   // optional
      inspector: { mount(container) { return { unmount() {} }; } },   // optional
      canvas:    { mount(blockEl)   { return { unmount() {} }; } },   // optional, runs in the preview page
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
  styles,                  // nx2 stylesheets (outline and inspector); [] in the preview page
  commit(html),            // replace this block (the host validates and applies)
                           //   → Promise<{ ok: true } | { ok: false, error, message }>
                           //   error: NOT_EDITABLE | STALE | INVALID_HTML | NO_EDITOR
  select(itemId),          // move the editor selection to an item (the host calls locate)
  onEditorSelect(cb),      // cb(itemId | null) when the editor selection moves inside this block (the host calls resolve)
}
```
DA, the preview page and the Block Inspector each create their own operator instance. All surfaces stay in sync through
the **editor selection**: `select(itemId)` moves it through the operator's `locate`, and `onEditorSelect` reports it back
through `resolve`. `resolve` and `locate` are part of every operator, not of one contract.

### `outline` (hosted by DA)
When a block row renders and its operator implements `outline`, DA renders an expand chevron and a container under the
row, then calls `outline.mount(container)`. Changes made in the mount are written with `ctx.commit`.

### `inspector` (hosted by the Block Inspector extension)
DA's tool panel is unchanged. The Block Inspector already follows the caret's block through the plugin SDK
(`subscribeLiveDocument`), writes with `sendHTML(html, { replace: true, expected })` (`document.js`), and loads the block
library's `editor` sheet (`library.js`, used for `isMultiBlock`). Changes:
1. Build an operator registry from the `editor` rows with `property: operator`.
2. When the selected block has an operator that implements `inspector`, mount it in the panel in place of the
   `fields` form. Otherwise, and if the operator throws, render today's form.
3. Back `ctx` with the SDK:
   | `ctx` | Backed by |
   |---|---|
   | `html`, `update()` | `subscribeLiveDocument` snapshots, narrowed to the selected block |
   | `editable` | The `editable` flag the host sends with the live document (`iframe-protocol.js`) |
   | `commit(html)` | `sendHTML(html, { replace: true, expected })` |
   | `onEditorSelect(cb)` | Selection changes in the live document |
   | `select(itemId)` | `locate`, then a **new SDK action**, `setSelection { blockIndex, position }`, to move the selection. Today's actions (`iframe-protocol.js`) can read the selection (`getSelection`) but not move it |

### `canvas` (hosted by the quick-edit plugin)
**Today:** the WYSIWYG canvas is the site's preview page in an iframe, running the quick-edit plugin
(da-nx `nx/public/plugins/quick-edit`). `quick-edit-init.js` activates it when the URL has `?quick-edit`, and imports the
site's own `scripts/aem.js` and `scripts/scripts.js`. Host and preview talk over a MessageChannel using
`MESSAGE_TYPES` (da-nx `nx/utils/message-types.js`, re-exported by da-live `canvas/utils/quick-edit-messages.js`):
- Preview → host: `NODE_SELECT { node: { anchorType, proseIndex, blockIndex? } | null }` on a click
  (`src/selection.js`), handled by `handleNodeSelect`, which sets a ProseMirror `NodeSelection`.
- Host → preview: `SET_SELECTED_NODE { node, scrollIntoView }`, sent when the editor selection changes
  (`ew-editor-doc.js` `_broadcastSelectedNode`). `SET_BODY` re-renders the page, or just one block
  (`rerenderScope: { type: 'block', … }`).

**Proposed:**
1. **Operator code in the preview.** After `READY`, the host sends a new `SET_OPERATORS { operators: { [name]: moduleUrl } }`.
   For each matching block, quick-edit imports the module, calls `create(ctx)`, and then `canvas.mount(blockEl)` on the
   decorated block element. It repeats this after `SET_BODY` re-renders the block. The operator owns overlays and
   gestures on that element, and quick-edit's own editing stays off inside it.
2. **`ctx` in the preview** maps to new messages on the same port:
   | `ctx` | Message |
   |---|---|
   | `html`, `update()` | `SET_BODY` (the block's HTML) |
   | `commit(html)` | New `OPERATOR_COMMIT { requestId, blockIndex, html }` → DA's `ctx.commit` (below); the reply carries `{ requestId, result }` |
   | `select(itemId)` | New `OPERATOR_SELECT { blockIndex, itemId }` → DA calls `locate` and sets the editor selection |
   | `onEditorSelect(cb)` | `SET_SELECTED_NODE`, extended with `itemId` (from DA's `resolve`) |
3. **Click mapping in DA.** When `handleNodeSelect` sets a selection inside a block that has an operator, DA calls
   `resolve` on it. The item id goes to the DA instance's `onEditorSelect` subscribers and out with `SET_SELECTED_NODE`.
   A null id keeps today's behaviour.

## `ctx.commit(html)` in DA
The SDK's `sendHTML` replace (`iframe-protocol.js`) rejects with `WRONG_SELECTION` or `STALE_LIVE` and then calls
`replaceHTMLAtCursor`. DA's operator commit uses similar guards, but targets the block **by index**:
1. Reject if the doc isn't editable (`view.editable`) or the block's HTML changed since the last `update`.
2. Take the block's start from `getBlockPositions` (`editor-utils/blocks.js`; the end is `pos + node.nodeSize`) and replace
   it with `replaceBlockRange(view, from, to, dom)`, which dispatches one `replaceWith`.
3. Reject if the HTML doesn't parse back to exactly one block of the same name.
4. On the following `editorHtmlState` update, call `update()` on the operator.

Whether one `replaceWith` is a single undo step needs verifying.

## Configuration: the block library's `editor` sheet
The block library index (the `Blocks` row of the DA config `library` sheet) can carry an `editor` sheet. da-live
(`editor-utils/multi-block.js`) and the Block Inspector already read it for `property: multi`:
| block | property | value |
|---|---|---|
| `cards` | `multi` | *(existing)* |
| `<block name>` | `operator` | `<operator module URL>` |

- `property: operator` and the `value` column (a JS module URL or site-relative path) are new.
- Operators are available only to sites with a block library, and are configured per site.

**Loading in DA:** `loadBlockEditor(org, site)` (`ew-panel-extensions/helpers.js`) already returns the `editor` rows,
memoized per org/site. A new `loadBlockOperators` filters them to `operator` and maps the block name, normalized as in
`multi-block.js`, to its module URL. The first row wins. A module is imported only when a matching block first
appears, and is then cached per block name. Until it loads, or if the import fails, the block keeps today's behaviour.
The outline and the WYSIWYG controller share this registry, and it is the source of `SET_OPERATORS`. When an operator
throws, DA destroys it for that block and falls back to the default behaviour.

## Where the operators live
- **Operator code**: `sakshi-arora1/daform/tools/block-operators/`: one module per operator, and a `README.md` describing
  the interface and the configuration (the Doc Url). The modules are served from the site:
  - `https://main--daform--sakshi-arora1.aem.live/tools/block-operators/accordion.js` (`resolve`, `locate`, `outline`)
  - `https://main--daform--sakshi-arora1.aem.live/tools/block-operators/form.js` (`resolve`, `locate`, `outline`,
    `inspector`, `canvas`)
- **Setup**: add `operator` rows to the `editor` sheet of the site's block library (see the README). Open canvas tabs
  pick them up on reload. A setup app and a marketplace entry are out of scope for this repo.
