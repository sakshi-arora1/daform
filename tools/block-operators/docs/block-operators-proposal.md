# Proposal: Block Operators, block-owned authoring in DA

## Problem
A block's authoring experience in DA canvas is fixed:
- **Outline** (`da-live/blocks/canvas/ew-page-outline/ew-page-outline.js`) shows each block as one row
  (`parseSections()` in `editor-utils/editor-utils.js`), with no view of the block's internal structure.
- **Block Inspector** (`adobe-rnd/ew-extensions/tools/block-editor`) builds its form from the library template's
  `fields` metadata, plus `multi` and `options` from the block library. It can't express a block-specific model.

Canvas selection is not part of this proposal. DA's WYSIWYG canvas already selects and highlights blocks, text and
images through quick-edit's instrumentation (`data-block-index`, `data-prose-index`, `data-image-index`) and the
`NODE_SELECT` / `SET_SELECTED_NODE` messages; block operators leverage it as is, with no new platform work.

## Block operator
A **block operator** is a JS module configured for a block name. It can take over that block's authoring through
two optional **contracts**. An operator may implement both, one or neither of them:
| Contract | Surface | Host | If not implemented |
|---|---|---|---|
| `outline` | The nested area under the block's row in the Outline | DA | Today's single row |
| `inspector` | The Block Inspector panel, while the caret is in the block | Block Inspector extension | Today's `fields`-based form |

![Block Operators architecture](assets/block-operators-architecture.svg)

Inside a contract's surface, the operator owns everything: rendering, drag and drop, keyboard, menus, dialogs, actions
and gestures. The host provides only a mount point and `ctx`. There is no canvas contract: no operator code runs in
the WYSIWYG canvas.
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
  styles,                  // nx2 stylesheets (outline and inspector)
  commit(html),            // replace this block (the host validates and applies)
                           //   → Promise<{ ok: true } | { ok: false, error, message }>
                           //   error: NOT_EDITABLE | STALE | INVALID_HTML | NO_EDITOR
  select(itemId),          // move the editor selection to an item (the host calls locate)
  onEditorSelect(cb),      // cb(itemId | null) when the editor selection moves inside this block (the host calls resolve)
}
```
DA and the Block Inspector each create their own operator instance. In DA, `select(itemId)` moves the editor caret
through the operator's `locate`, and `onEditorSelect` reports the caret back through `resolve`. The outline and the
Block Inspector share the selected item through [selection sync](#selection-sync), which runs in the site's own code.

Only two codebases change: da-live hosts the `outline` contract (one commit, `62d7b7f2` on the
`sakshi-arora1/da-live` `feat/block-operator` branch), and the site (daform) ships the operators, its copy of the Block
Inspector that hosts the `inspector` contract, and the selection sync. da-nx and ew-extensions are unchanged.

### `outline` (hosted by DA)
When a block row renders and its operator implements `outline`, DA renders an expand chevron and a container under the
row, then calls `outline.mount(container)`. Changes made in the mount are written with `ctx.commit`. DA's own instance
backs `select` (`locate`, then a caret in the block) and `onEditorSelect` (`resolve` on editor selection changes).

### `inspector` (hosted by the site's Block Inspector)
DA's tool panel is unchanged. The site serves a copy of the Block Inspector (`tools/block-editor`, from
ew-extensions), added as a sidebar extension. It already follows the caret's block through the plugin SDK
(`subscribeLiveDocument`), writes with `sendHTML(html, { replace: true, expected })` (`document.js`), and loads the block
library's `editor` sheet (`library.js`, used for `isMultiBlock`). Changes in the copy:
1. Build an operator registry from the `editor` rows with `property: operator`.
2. When the selected block has an operator that implements `inspector`, mount it in the panel in place of the
   `fields` form. Otherwise, and if the operator throws, render today's form.
3. Back `ctx` with the SDK:
   | `ctx` | Backed by |
   |---|---|
   | `html`, `update()` | `subscribeLiveDocument` snapshots, narrowed to the selected block |
   | `editable` | The `editable` flag the host sends with the live document (`iframe-protocol.js`) |
   | `commit(html)` | `sendHTML(html, { replace: true, expected })` |
   | `onEditorSelect(cb)` | [Selection sync](#selection-sync) messages for this block |
   | `select(itemId)` | [Selection sync](#selection-sync): tells the outline, which moves the caret |

## Selection sync
The outline (in the da.live page) and the Block Inspector (an iframe on the site's `preview.da.live` origin) show the same
selected item. This runs in the site's code (`scripts/block-operator-sync.js`), with no platform change beyond the outline
host:
- **Message:** `{ type: 'block-operator-select', org, site, path?, blockIndex, block, itemId, source }`. Item ids are
  stable across reordering (the form uses the item's `id`, then `name`, then its JSON pointer).
- **Outline → Block Inspector:** on a selection in the tree, or when the editor caret moves to another item
  (`onEditorSelect`), the operator posts the message to the page's iframes on the site's origin
  (`https://{ref}--{site}--{org}.preview.da.live`, `aem.page`, `aem.live`; a local server when DA runs locally), with that
  origin as `targetOrigin`. It keeps the last selection and answers `{ type: 'block-operator-get-selection' }`.
- **Block Inspector → outline:** the inspector posts to its parent (`https://da.live`, a da-live branch, or a local
  server). The outline highlights the item and moves the caret with `select(itemId)`. On load, the inspector asks for the
  current selection and shows that item when it is in the selected block (same `blockIndex`, or the operator can
  `locate` it).
- **Guards:** every listener checks the sender's origin and ignores other orgs and sites. A selection received from
  another surface is applied but never re-published, repeats of the latest selection are dropped, and messages are
  rate-limited, so the surfaces can't echo each other.

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
The outline uses this registry; the site's Block Inspector reads the same rows. When an operator
throws, DA destroys it for that block and falls back to the default behaviour.

## Where the operators live
- **Operator code**: `sakshi-arora1/daform/tools/block-operators/`: one module per operator, and a `README.md` describing
  the interface and the configuration (the Doc Url). The modules are served from the site:
  - `https://main--daform--sakshi-arora1.preview.da.live/tools/block-operators/accordion.js` (`resolve`, `locate`, `outline`)
  - `https://main--daform--sakshi-arora1.preview.da.live/tools/block-operators/form.js` (`resolve`, `locate`, `outline`,
    `inspector`)
- **Block Inspector**: `sakshi-arora1/daform/tools/block-editor/`, and `scripts/block-operator-sync.js` for the selection
  sync.
- **Setup**: add `operator` rows to the `editor` sheet of the site's block library (see the README). Open canvas tabs
  pick them up on reload. A setup app and a marketplace entry are out of scope for this repo.
