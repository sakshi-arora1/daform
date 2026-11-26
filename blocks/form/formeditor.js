/*
 * Form editing support for DA's Layout view (the page loaded with `?quick-edit`). form.js only
 * renders; this module listens for its `form:rendered` event and:
 * - tags each rendered item with its stable id (`data-item-id`: the item's `id`, else `name`,
 *   else JSON pointer, as formItemIds in scripts/block-operator-sync.js assigns them), and its
 *   editable parts with the property they show (`data-item-prop`);
 * - syncs the selected item with the block operators' outline and Block Inspector: highlights
 *   it, and publishes clicks on items.
 * scripts/scripts.js loads it only in Layout, so Preview and the published page never run it.
 */
import { loadCSS, toClassName } from '../../scripts/aem.js';
import {
  connectFrame, formItemIds, normalizeBlock, siteOf,
} from '../../scripts/block-operator-sync.js';

const SELECTED_CLASS = 'block-operator-selected';
const ITEM = '.field-wrapper[data-id]';
const PARTS = [
  [':scope > .field-label', 'label.value'],
  [':scope > .field-description', 'description'],
];
const TYPE_PARTS = {
  image: [':scope > picture', 'value'],
  'plain-text': [':scope > p', 'value'],
};

// The rendered items whose nearest enclosing item is `scope` (the form, or a panel instance).
function childItems(scope) {
  return [...scope.querySelectorAll(ITEM)]
    .filter((el) => el.parentElement.closest(`${ITEM}, form`) === scope);
}

// Rendered elements of an authored item among its siblings: by name (repeatable panels render
// one element per instance), else by authored id, else by position.
function findRendered(candidates, item, index) {
  const cls = item?.name ? `field-${toClassName(item.name)}` : null;
  const byName = cls ? candidates.filter((el) => el.classList.contains(cls)) : [];
  if (byName.length) return byName;
  const byId = item?.id ? candidates.filter((el) => el.dataset.id === item.id) : [];
  if (byId.length) return byId;
  return candidates[index] ? [candidates[index]] : [];
}

function tagElement(element, itemId, item) {
  element.dataset.itemId = itemId;
  [...PARTS, ...(TYPE_PARTS[item?.fieldType] ? [TYPE_PARTS[item.fieldType]] : [])]
    .forEach(([selector, prop]) => {
      element.querySelector(selector)?.setAttribute('data-item-prop', prop);
    });
}

/** Tag the rendered items of `form` (a <form>) from the authored `definition`. */
function tagItems(form, definition) {
  const { idOf } = formItemIds(definition);
  const walk = (items, scopes, base) => (Array.isArray(items) ? items : []).forEach((item, i) => {
    const pointer = `${base}/items/${i}`;
    const found = scopes.flatMap((scope) => findRendered(childItems(scope), item, i));
    // A repeatable panel renders a container whose items are its instances (same name).
    const elements = found.flatMap((el) => {
      const instances = childItems(el).filter((child) => child.dataset.repeatable === 'true'
        && child.className.split(' ').some((c) => c.startsWith('field-') && el.classList.contains(c)));
      return instances.length ? [el, ...instances] : [el];
    });
    elements.forEach((el) => tagElement(el, idOf.get(pointer), item));
    const scopesOfItems = elements.filter((el) => !elements.some((other) => other !== el
      && el.contains(other)));
    if (Array.isArray(item?.items)) walk(item.items, scopesOfItems, pointer);
  });
  walk(definition?.items, [form], '');
}

// Index of a block among the page's top-level blocks (DA counts the document's blocks the same
// way, except for auto-blocks; receivers also match by item id).
function blockOrdinal(block) {
  return [...document.querySelectorAll('main .block')]
    .filter((el) => !el.parentElement.closest('.block'))
    .indexOf(block);
}

function highlightItem(message, { scroll = true } = {}) {
  document.querySelectorAll(`main .form .${SELECTED_CLASS}`)
    .forEach((el) => el.classList.remove(SELECTED_CLASS));
  if (message?.itemId == null) return;
  const selector = `[data-item-id="${CSS.escape(message.itemId)}"]`;
  const blocks = [...document.querySelectorAll('main .form.block')]
    .filter((block) => block.querySelector(selector));
  const block = blocks.find((el) => blockOrdinal(el) === message.blockIndex) ?? blocks[0];
  const item = block?.querySelector(selector);
  if (!item) return;
  item.classList.add(SELECTED_CLASS);
  if (scroll) item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// On a local dev server the hostname doesn't name the site; take it from DA's messages.
const state = { current: null, site: siteOf(window.location.origin) };

const connection = connectFrame({
  scope: () => state.site,
  onSelect: (message) => {
    if (normalizeBlock(message.block) !== 'form') return;
    state.site ??= message.org && message.site ? { org: message.org, site: message.site } : null;
    state.current = message;
    highlightItem(message);
  },
});

// Capture, and no preventDefault: quick-edit keeps handling the same click.
document.addEventListener('click', (event) => {
  const item = event.target.closest?.('.form.block [data-item-id]');
  if (!item) return;
  const message = {
    path: window.location.pathname,
    blockIndex: blockOrdinal(item.closest('.form.block')),
    block: 'form',
    itemId: item.dataset.itemId,
    source: 'preview',
  };
  state.current = message;
  highlightItem(message);
  connection.publish(message);
}, true);

const observed = new WeakSet();

document.addEventListener('form:rendered', (event) => {
  const { form, definition } = event.detail ?? {};
  if (!form || !definition) return;
  tagItems(form, definition);
  highlightItem(state.current);
  if (observed.has(form)) return;
  observed.add(form);
  // Rules add and remove items (repeatable instances, fragments): tag what they render.
  let pending = false;
  new MutationObserver(() => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      tagItems(form, definition);
      highlightItem(state.current, { scroll: false });
    });
  }).observe(form, { childList: true, subtree: true });
});

loadCSS(`${window.hlx?.codeBasePath ?? ''}/blocks/form/formeditor.css`);
connection.requestSelection();
