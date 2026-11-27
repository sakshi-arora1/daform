# Form Editor

A DA sidebar extension for the form block (`blocks/form`). With the cursor in a form block, it
shows the form's outline and edits the form JSON in the block's code block. It stands alone: it
needs no other extension or block operator.

## Setup

Add a row to the `library` sheet of the site's DA config (`https://da.live/config#/{org}/{site}/`):

| title | path |
|---|---|
| Form Editor | `https://main--daform--sakshi-arora1.preview.da.live/tools/form-editor/form-editor.html` |

Reload the editor, open **Form Editor** from the sidebar, and place the cursor in a form block.

## Outline

- One row per item: its component (small, gray) and its label. Panels show their items indented
  under a guide line. The top row is the form and its title; its only action, the wrench, opens the
  form's properties (its title, and its settings as JSON; the items are kept).
- Hover a row (or select it) for its actions:
  - **+** opens the component list and inserts the chosen component after the item, or at the end
    of a panel (on a panel's row). An empty form shows **Add a component** instead.
  - **Duplicate** inserts a copy after the item, with new names (and ids) for it and its items.
  - **Wrench** opens the item's property sheet (also: double-click, or Enter).
  - **Dustbin** deletes the item (also: Delete).
- Drag a row to move the item: onto the top or bottom half of a row to place it before or after,
  onto the middle of a panel to move it inside. Alt+↑ / Alt+↓ moves the focused row.

## Property sheet

Built from the component models in `blocks/form/models/form-components` (`...` references into
`form-common` are resolved): the model's tabs (Basic, Validation, Help Content, …), its fields and
their conditions, plus a **JSON** tab for the item as a whole. Changes are saved as soon as a field
changes. Model fields map to the item's AF JSON:

- `jcr:title` → `label.value`, `hideTitle` → `label.visible: false`
- `*Message` fields → `constraintMessages.*`, `minimumDate` / `maximumDate` → `minimum` / `maximum`
- `checkedValue` / `uncheckedValue` → `enum[0]` / `enum[1]`, `orientation` →
  `properties["afs:layout"].orientation`, `textIsRich` → `richText`
- standard AF properties (`name`, `required`, `placeholder`, `default`, `enum`, `description`, …)
  stay top-level; any other field goes under `properties`. Empty values remove the property.

An item's component is chosen by its `:type`, then its `fieldType` (`text`, `select`, `tel`,
`text-area`, `date`, `file`, … are accepted too); buttons by `buttonType`. Unknown types use the
Text Input model.

## How it works

- `form-editor.js` follows the live document with the DA plugin SDK
  (`actions.subscribeLiveDocument`). The selected block (`selection.blockIndex`) is used when it is
  a form block (`form-model.js` `readFormBlock`).
- Each change rewrites the form JSON (keeping its indentation) and replaces the block with
  `actions.sendHTML(html, { replace: true, expected })`. DA refuses the change if the cursor left
  the block or the document changed meanwhile; the sidebar then shows the error.
- `components.js` loads the component models from the site
  (`/blocks/form/models/form-components/`).
- Tests: `npm test` (`test/form-editor.test.mjs`).
