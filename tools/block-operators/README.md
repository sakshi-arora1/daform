# Block operators

A **block operator** is a JS module, configured for a block name, that takes over parts of that block's authoring
in DA through optional **contracts**. Background and host design:
[docs/block-operators-proposal.md](docs/block-operators-proposal.md).

| Module | URL | Implements |
|---|---|---|
| `accordion.js` | `https://main--daform--sakshi-arora1.aem.live/tools/block-operators/accordion.js` | `resolve`, `locate`, `outline` |
| `form.js` | `https://main--daform--sakshi-arora1.aem.live/tools/block-operators/form.js` | `resolve`, `locate`, `outline`, `inspector`, `canvas` |

`shared.js` holds helpers used by both (outline tree, shadow mount, commit).

## Configuration

Add rows to the `editor` sheet of the site's block library (the sheet linked from the `Blocks` row of the DA config
`library` sheet), next to any existing `multi` rows:

| block | property | value |
|---|---|---|
| `accordion` | `operator` | `https://main--daform--sakshi-arora1.aem.live/tools/block-operators/accordion.js` |
| `form` | `operator` | `https://main--daform--sakshi-arora1.aem.live/tools/block-operators/form.js` |

- `value` is a module URL, or a site-relative path (`/tools/block-operators/form.js`) resolved against
  `https://main--{site}--{org}.aem.live`.
- Block names are matched case-insensitively, with spaces, `-` and `_` treated alike. The first row per block wins.
- Sites without `operator` rows are unaffected. Open canvas tabs pick up changes on reload.

## Interface

```js
export default {
  matches({ name, variant }) { return true; },          // optional
  create(ctx) {                                          // once per block instance, per host
    return {
      update(nextCtx) {},                                // block html or editability changed
      destroy() {},
      resolve(position) {},                              // position → itemId | null
      locate(itemId) {},                                 // itemId → position | null
      outline:   { mount(container) { return { unmount() {} }; } },   // optional, hosted by DA
      inspector: { mount(container) { return { unmount() {} }; } },   // optional, hosted by Block Inspector
      canvas:    { mount(blockEl)   { return { unmount() {} }; } },   // optional, preview page (quick-edit)
    };
  },
};
```

A **position** is `{ row, cell, textOffset? }`: the 0-based content row of the block (header row excluded), the
0-based cell in that row, and an optional character offset into that cell's text.

```
ctx = {
  name, variant,      // block name and variant
  blockIndex,         // index of the block among the document's blocks
  html,               // the block's EDS markup: <div class="name variant"><div><div>…</div></div>…</div>
  editable,           // false when the document is read-only
  styles,             // nx2 CSSStyleSheets (form.css, buttons.css); [] in the preview page
  commit(html),       // replace this block → Promise<{ ok: true } | { ok: false, error, message }>
                      //   error: NOT_EDITABLE | STALE | INVALID_HTML | NO_EDITOR
  select(itemId),     // move the editor selection to an item (the host calls locate)
  onEditorSelect(cb), // cb(itemId | null) when the editor selection moves in this block; returns unsubscribe
}
```

DA, the preview page and the Block Inspector each create their own instance; they stay in sync through the editor
selection (`select` → `locate`, `resolve` → `onEditorSelect`). `ctx.commit` is the only way to change the document and
replaces only the operator's own block. Operator UI is mounted in a shadow root that adopts `ctx.styles`; drag and drop
stays inside the mount.

## Contracts

| Contract | Surface | If not implemented |
|---|---|---|
| `outline` | Nested area under the block's row in DA's Outline | The single block row |
| `inspector` | The Block Inspector panel while the caret is in the block | The `fields`-based form |
| `canvas` | The rendered block in the WYSIWYG preview | quick-edit's own editing |

## accordion.js

- Item id: the row index (`"0"`, `"1"`, …). `resolve` maps any position in a row to that row; `locate` returns
  `{ row, cell: 0 }`.
- `outline`: one node per row, labelled with the text of the row's first cell. Click or Enter selects the row in the
  editor. Reorder by drag or Alt+ArrowUp/Down; delete with the ✕ button or Delete/Backspace.

## form.js

- Model: the adaptive form JSON in the block's `pre > code` (items nest through `items`; each has `name`,
  `fieldType`, `label.value`). The JSON is rewritten with the indentation it had.
- Item id: the item's JSON pointer, e.g. `/items/1` or `/items/17/items/0`. `resolve` maps a `textOffset` inside the
  code to the innermost item whose JSON contains it; `locate` returns the offset of the item's opening `{`.
- `outline`: tree of items (panels nest), reorder within the same parent by drag or Alt+ArrowUp/Down, delete.
- `inspector`: pick a field, then edit its label, name, type and required flag; **Apply** commits.
- `canvas`: on the form rendered by `blocks/form`, highlights the selected field and selects a field on click
  (`ctx.select`). Fields are matched by `data-id` (the item's `id`), then by the `field-<name>` class.
