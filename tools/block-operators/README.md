# Block operators

A **block operator** is a JS module, configured for a block name, that takes over parts of that block's authoring
in DA through optional **contracts**. Background and host design:
[docs/block-operators-proposal.md](docs/block-operators-proposal.md).

| Module | URL | Implements |
|---|---|---|
| `accordion.js` | `https://main--daform--sakshi-arora1.preview.da.live/tools/block-operators/accordion.js` | `resolve`, `locate`, `outline` |
| `form.js` | `https://main--daform--sakshi-arora1.preview.da.live/tools/block-operators/form.js` | `resolve`, `locate`, `outline`, `inspector` |

`shared.js` holds helpers used by both (outline tree, direct mount with scoped CSS, commit).

## Configuration

Add rows to the `editor` sheet of the site's block library (the sheet linked from the `Blocks` row of the DA config
`library` sheet), next to any existing `multi` rows:

| block | property | value |
|---|---|---|
| `accordion` | `operator` | `https://main--daform--sakshi-arora1.preview.da.live/tools/block-operators/accordion.js` |
| `form` | `operator` | `https://main--daform--sakshi-arora1.preview.da.live/tools/block-operators/form.js` |

- `value` is a module URL, or a site-relative path (`/tools/block-operators/form.js`). Operators are loaded with
  `import()` from other origins (da.live, the Block Inspector iframe), so they must be served with CORS headers:
  `https://main--{site}--{org}.preview.da.live` sends them, `aem.live` and `aem.page` don't. The Block Inspector
  resolves `/…` against its own origin when it is served from the same site.
- Block names are matched case-insensitively, with spaces, `-` and `_` treated alike. The first row per block wins.
- Sites without `operator` rows are unaffected. Open canvas tabs pick up changes on reload.
- The `inspector` contract is hosted by the Block Inspector in [`../block-editor`](../block-editor/README.md); add
  `https://main--daform--sakshi-arora1.preview.da.live/tools/block-editor/block-editor.html` as a sidebar extension in the
  `library` sheet.

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
      edit() {},                                         // optional: Layout pencil; true = handled
      outline:   { mount(container) { return { unmount() {} }; } },   // optional, hosted by DA
      inspector: { mount(container) { return { unmount() {} }; } },   // optional, hosted by Block Inspector
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
  commit(html),       // replace this block → Promise<{ ok: true } | { ok: false, error, message }>
                      //   error: NOT_EDITABLE | STALE | INVALID_HTML | NO_EDITOR
  select(itemId),     // select an item: DA moves the caret (locate); the Block Inspector shares it
  onEditorSelect(cb), // cb(itemId | null) when the selection moves in this block; returns unsubscribe
  surface,            // 'inspector' in the Block Inspector; absent in DA
  openPanel(nameOrId),// DA only: open a tool-panel view by id or extension title → boolean
  setChatContext(item),// DA only: { label, innerText, pinnable? } as this block's chat context; null clears
}
```

DA and the Block Inspector each create their own instance. In DA, `select` moves the caret through `locate`, and
`onEditorSelect` reports the caret through `resolve`; the surfaces share the selected item through
[selection sync](#selection-sync). `ctx.commit` is the only way to change the document and
replaces only the operator's own block. Operator UI renders directly into the mount container, so the host surface's sheets (nx2 form and buttons) apply; the operators' own CSS is added to the host's root once, scoped under `.block-operator`; drag and drop
stays inside the mount.

Hook points (DA only; without them DA behaves as before):
- `ctx.setChatContext(item | null)`: adds `item` to the chat (Coworker) context as this block's entry; DA fills in
  the block name and position. The operator decides when and what to send; DA clears it when the instance goes away.
- `edit()`: called when the Layout view's **Edit block** pencil is clicked for this block. Return `true` to skip DA's
  default (the raw block editor).

## Contracts

| Contract | Surface | If not implemented |
|---|---|---|
| `outline` | Nested area under the block's row in DA's Outline | The single block row |
| `inspector` | The Block Inspector panel while the caret is in the block | The `fields`-based form |

## accordion.js

- Item id: the row index (`"0"`, `"1"`, …). `resolve` maps any position in a row to that row; `locate` returns
  `{ row, cell: 0 }`.
- `outline`: one node per row, labelled with the text of the row's first cell. Click or Enter selects the row in the
  editor. Reorder by drag or Alt+ArrowUp/Down; delete with the delete (dustbin) button or Delete/Backspace.

## form.js

- Model: the adaptive form JSON in the block's `pre > code` (items nest through `items`; each has `name`,
  `fieldType`, `label.value`). The JSON is rewritten with the indentation it had.
- Item id: the item's `id`, else its `name`, else its JSON pointer (`/items/17/items/0`); an id already taken falls
  back to the pointer (`formItemIds` in `scripts/block-operator-sync.js`). Ids survive reordering. `resolve` maps a
  `textOffset` inside the code to the innermost item whose JSON contains it; `locate` returns the offset of the item's
  opening `{`.
- `outline`: tree of items (panels nest), reorder within the same parent by drag or Alt+ArrowUp/Down, delete.
- Chat context: on `onEditorSelect`, the field's label, a summary (type, name, required) and its JSON go to
  `ctx.setChatContext`; leaving the field clears it.
- `edit`: opens the Block Inspector (`ctx.openPanel('Block Inspector')`, the extension title in the DA config
  `library` sheet), so the Layout pencil edits the field properties instead of the raw JSON.
- `inspector` (`form-inspector.js`): the selected item's properties, driven by the Universal Editor component models
  in `blocks/form/models/form-components` (fetched from the site; `...` references into `form-common` are resolved).
  The header shows the component title and the item's label; the model's `tab` fields become tabs (Basic,
  Validation, Help Content, …), plus a **JSON** tab with the raw item. Edits commit on change.
  - Item → model: by `:type`, then `fieldType`, through an alias table (`text` → `text-input`, `select` →
    `drop-down`, `tel` → `telephone-input`, `text-area` → `multiline-input`, `file`, `date`, `number`, `radio`,
    `heading` → `plain-text`, …); buttons pick submit/reset by `buttonType` or `events.click`. Anything else uses
    the text input model.
  - Model field → item: `jcr:title` → `label.value`, `hideTitle` → `label.visible: false`, `*Message` fields →
    `constraintMessages.*`, `minimumDate`/`maximumDate` → `minimum`/`maximum`, `orientation` →
    `properties["afs:layout"].orientation`; standard AF properties (`name`, `required`, `placeholder`, `default`,
    `enum`, `description`, `tooltip`, `pattern`, `minLength`, …) stay top-level; anything else goes under
    `properties`. Empty values remove the property.
  - Field components: `text` (`multi` → one value per line), `number`, `boolean`, `select`, `radio-group`,
    `richtext` (plain textarea), `date-time`; `datasource-bindref`, `aem-content` and `reference` fall back to a
    text input, `container` shows its label as a note, `edit-fragment` is hidden. `condition` (json-logic `===`,
    `!==`, `and`, `or`, `!`, `var`) and `required` / `validation.regExp` are honoured.

## Layout view (no contract)

No operator code runs in DA's Layout view (the WYSIWYG canvas). Instead, a block marks its rendered items there:

- `data-item-id`: the operator's item id on the element that renders the item.
- `data-item-prop`: the item property a part shows (`label.value`, `description`, `value`).

`blocks/form/form.js` only renders the form, in Layout, Preview and on the published page, and then dispatches
`form:rendered` (`{ form, definition }`, the authored JSON) on the block. `blocks/form/formeditor.js`, which
`scripts/scripts.js` loads only when the page URL has `?quick-edit` (Layout), listens for it and adds both attributes:
each rendered item gets its item id (`email`), including every instance of a repeatable panel; the label, help text,
image and plain-text paragraph get `data-item-prop`. It re-tags items that rules add later. See
[the proposal](docs/block-operators-proposal.md#layout-view-item-attributes).

## Selection sync

The outline, the Block Inspector and the Layout view show the same item without platform changes beyond the outline
host (`scripts/block-operator-sync.js`):

- Message: `{ type: 'block-operator-select', org, site, path?, blockIndex, block, itemId, source }`
  (`source`: `outline`, `inspector` or `preview`).
- Outline (da.live page): a selection in the tree, or the caret moving to another item, is posted to the page's
  site iframes (`https://{ref}--{site}--{org}.preview.da.live`, `aem.page`, `aem.live`, or a local server), with their
  origin as `targetOrigin`. Selections from the iframes are highlighted in the tree, move the caret, and are relayed to
  the other iframes. The outline answers `{ type: 'block-operator-get-selection' }` with the last selection.
- Block Inspector and Layout view (iframes): post to the parent DA origin and share
  `BroadcastChannel('block-operators')`. The inspector asks for the current selection when it loads and shows the
  item when it is in the selected block; the Layout view outlines `[data-item-id]` and publishes clicks on items.
- Listeners check origins (site origins in DA; `https://da.live`, a da-live branch or a local server in the iframes)
  and ignore other orgs and sites. A message matches a block by `blockIndex`, or by item id when the counts differ
  (the Layout page may count auto-blocks).
