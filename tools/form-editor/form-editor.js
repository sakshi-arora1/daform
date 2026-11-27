/*
 * Form Editor: a DA sidebar extension for the form block. It follows the caret's block in DA's
 * live document and, inside a form block, shows the form's outline and the property sheet of
 * its items. Changes are written back to the block's form JSON with sendHTML replace.
 */
// eslint-disable-next-line import/no-unresolved
import DA_SDK from 'https://da.live/nx/utils/sdk.js';
import {
  blockHtml, duplicateItem, insertItem, isContainer, isWithin, itemAt, moveItem, plainText,
  readFormBlock, removeItem, samePath,
} from './form-model.js';
import {
  componentFor, describeItem, FORM_COMPONENT, isShown, loadComponents, newItem, readField, tabsOf,
  validateField, writeField,
} from './components.js';

const ICONS = {
  add: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4v12M4 10h12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none"/></svg>',
  copy: '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="7" y="7" width="9" height="9" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M13 7V5.5A1.5 1.5 0 0 0 11.5 4h-6A1.5 1.5 0 0 0 4 5.5v6A1.5 1.5 0 0 0 5.5 13H7" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
  wrench: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M12.7 3.3a4 4 0 0 0-4.9 5.2l-4.4 4.4a1.6 1.6 0 0 0 2.3 2.3l4.4-4.4a4 4 0 0 0 5.2-4.9l-2.5 2.5-2.2-.4-.4-2.2z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>',
  delete: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 6h12M8 6V4.5h4V6M6 6l.7 9.5h6.6L14 6M8.5 8.5v4.5M11.5 8.5v4.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  back: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M12 5l-5 5 5 5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

const ERRORS = {
  WRONG_SELECTION: 'The caret left the form block. Click in the form and try again.',
  STALE_LIVE: 'The document changed while saving. Try again.',
  READ_ONLY: 'The document is read-only.',
  NO_EDITOR: 'No document is open.',
  unsupported: 'This version of DA can’t replace blocks from an extension.',
};

const state = {
  sdk: null,
  live: null, // { html, blockIndex, editable }
  form: null, // readFormBlock() result for the selected block
  components: [],
  view: 'outline', // 'outline' | 'properties'
  selected: null, // path of the selected item
  tab: 0,
  fieldErrors: new Map(),
  jsonDraft: undefined,
  message: '',
  busy: false,
  drag: null, // { from: path }
};

const app = document.getElementById('app');
const dialog = document.getElementById('insert-dialog');

/* ---------- DOM helper ---------- */

function h(tag, props = {}, children = []) {
  const el = document.createElement(tag);
  Object.entries(props).forEach(([key, value]) => {
    if (value === undefined || value === null || value === false) return;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key === 'icon') el.innerHTML = ICONS[value];
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key in el && !key.includes('-')) el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  });
  el.append(...[children].flat().filter((c) => c !== null && c !== undefined && c !== false));
  return el;
}

const pathKey = (path) => path.join('.');

/* ---------- Writing ---------- */

let queue = Promise.resolve();

function setMessage(message) {
  state.message = message;
  // eslint-disable-next-line no-use-before-define
  render();
}

/**
 * Apply `change(model)` to the current form JSON and write the block back. `change` returns the
 * path to select afterwards, undefined to keep the selection, or false to cancel.
 */
function edit(change) {
  queue = queue.then(async () => {
    const { form, live, sdk } = state;
    if (!form?.model || !live?.editable) return;
    const model = structuredClone(form.model);
    const next = change(model);
    if (next === false) return;
    state.busy = true;
    let result;
    try {
      result = await sdk.actions.sendHTML(blockHtml(form, model), {
        replace: true,
        expected: { html: live.html, blockIndex: live.blockIndex },
      });
    } catch (error) {
      result = { ok: false, error: error?.code, message: error?.message };
    }
    state.busy = false;
    if (!result?.ok) {
      setMessage(`Could not save: ${ERRORS[result?.error] ?? result?.message ?? result?.error ?? 'unknown error'}`);
      return;
    }
    state.message = '';
    if (next !== undefined) state.selected = next;
    if (typeof result.html === 'string') {
      // eslint-disable-next-line no-use-before-define
      receive({ html: result.html, selection: result.selection, editable: result.editable });
    }
  });
  return queue;
}

/* ---------- Insert dialog ---------- */

function openInsert(parentPath, index) {
  const list = state.components.filter((c) => c.insertable)
    .sort((a, b) => a.title.localeCompare(b.title));
  const search = h('input', {
    class: 'nx-input fe-search', type: 'search', placeholder: 'Search components', 'aria-label': 'Search components',
  });
  const choose = (component) => {
    dialog.close();
    edit((model) => insertItem(model, parentPath, newItem(component, model), index));
  };
  const items = list.map((component) => h('li', {}, h('button', {
    type: 'button', class: 'fe-component', onclick: () => choose(component),
  }, [h('span', { class: 'fe-component-title', text: component.title }),
    h('span', { class: 'fe-component-id', text: component.id })])));
  const ul = h('ul', { class: 'fe-components' }, items);
  search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    items.forEach((li, i) => {
      li.hidden = !!q && !`${list[i].title} ${list[i].id}`.toLowerCase().includes(q);
    });
  });
  search.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const first = items.find((li) => !li.hidden);
    if (first) first.querySelector('button').click();
  });
  const target = parentPath.length ? describeItem(itemAt(state.form.model, parentPath), state.components).label : 'the form';
  dialog.replaceChildren(h('form', { method: 'dialog', class: 'fe-dialog' }, [
    h('div', { class: 'fe-dialog-head' }, [
      h('h2', { text: 'Insert component' }),
      h('p', { class: 'fe-muted', text: index === undefined ? `At the end of ${target}` : 'After the selected item' }),
    ]),
    search,
    ul,
    h('div', { class: 'fe-dialog-actions' }, h('button', { class: 'nx-action-btn', value: 'cancel', text: 'Cancel' })),
  ]));
  dialog.showModal();
  search.focus();
}

/* ---------- Outline ---------- */

function actions(path, item) {
  const disabled = !state.live?.editable || state.busy;
  const button = (icon, label, onclick) => h('button', {
    type: 'button', class: `fe-action fe-action-${icon}`, title: label, 'aria-label': label, disabled, tabIndex: -1, icon, onclick: (e) => { e.stopPropagation(); onclick(); },
  });
  const container = isContainer(item);
  return h('span', { class: 'fe-actions' }, [
    button('add', container ? 'Insert inside' : 'Insert after', () => (container
      ? openInsert(path) : openInsert(path.slice(0, -1), path.at(-1) + 1))),
    button('copy', 'Duplicate', () => edit((model) => duplicateItem(model, path))),
    button('wrench', 'Properties', () => {
      // eslint-disable-next-line no-use-before-define
      openProperties(path);
    }),
    button('delete', 'Delete', () => edit((model) => {
      removeItem(model, path);
      return null;
    })),
  ]);
}

// Where a drop over `row` (for the item at `path`) puts the dragged item.
function dropTarget(event, row, path, item) {
  const rect = row.getBoundingClientRect();
  const y = (event.clientY - rect.top) / Math.max(rect.height, 1);
  if (!path.length) return { parent: [], index: undefined, zone: 'inside' };
  if (isContainer(item) && y > 0.3 && y < 0.7) return { parent: path, index: undefined, zone: 'inside' };
  return y < 0.5
    ? { parent: path.slice(0, -1), index: path.at(-1), zone: 'before' }
    : { parent: path.slice(0, -1), index: path.at(-1) + 1, zone: 'after' };
}

function clearDropMarks() {
  app.querySelectorAll('.is-drop-before, .is-drop-after, .is-drop-inside')
    .forEach((el) => el.classList.remove('is-drop-before', 'is-drop-after', 'is-drop-inside'));
}

function dragHandlers(row, path, item) {
  const editable = state.live?.editable;
  row.draggable = !!editable && path.length > 0;
  row.addEventListener('dragstart', (e) => {
    state.drag = { from: path };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('application/x-form-editor-item', pathKey(path));
    row.classList.add('is-dragging');
  });
  row.addEventListener('dragend', () => {
    state.drag = null;
    row.classList.remove('is-dragging');
    clearDropMarks();
  });
  row.addEventListener('dragover', (e) => {
    const from = state.drag?.from;
    if (!from) return;
    const target = dropTarget(e, row, path, item);
    clearDropMarks();
    if (isWithin(target.parent, from)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    row.classList.add(`is-drop-${target.zone}`);
  });
  row.addEventListener('dragleave', () => row.classList.remove('is-drop-before', 'is-drop-after', 'is-drop-inside'));
  row.addEventListener('drop', (e) => {
    const from = state.drag?.from;
    state.drag = null;
    clearDropMarks();
    if (!from) return;
    const target = dropTarget(e, row, path, item);
    if (isWithin(target.parent, from)) return;
    e.preventDefault();
    edit((model) => moveItem(model, from, target.parent, target.index) ?? false);
  });
}

function onRowKey(e, path) {
  const rows = [...app.querySelectorAll('.fe-row')];
  const index = rows.indexOf(e.currentTarget);
  if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && path.length) {
    e.preventDefault();
    const up = e.key === 'ArrowUp';
    const siblings = itemAt(state.form.model, path.slice(0, -1)).items;
    const to = path.at(-1) + (up ? -1 : 2);
    if (to < 0 || to > siblings.length) return;
    edit((model) => moveItem(model, path, path.slice(0, -1), to));
  } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault();
    rows[index + (e.key === 'ArrowUp' ? -1 : 1)]?.focus();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    // eslint-disable-next-line no-use-before-define
    openProperties(path);
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && path.length && state.live?.editable) {
    e.preventDefault();
    edit((model) => {
      removeItem(model, path);
      return null;
    });
  } else if (e.key === ' ') {
    e.preventDefault();
    state.selected = path;
    // eslint-disable-next-line no-use-before-define
    render();
  }
}

function renderRow(path, item) {
  const { type, label } = describeItem(item, state.components);
  const selected = samePath(state.selected, path);
  const row = h('div', {
    class: `fe-row${selected ? ' is-selected' : ''}`,
    role: 'treeitem',
    tabIndex: 0,
    'aria-selected': String(selected),
    'data-key': `row:${pathKey(path)}`,
    onclick: () => {
      state.selected = path;
      // eslint-disable-next-line no-use-before-define
      render();
    },
    ondblclick: () => {
      // eslint-disable-next-line no-use-before-define
      openProperties(path);
    },
    onkeydown: (e) => onRowKey(e, path),
  }, [
    h('span', { class: 'fe-grip', text: '⋮⋮', 'aria-hidden': 'true' }),
    h('span', { class: 'fe-type', text: type }),
    h('span', { class: 'fe-label', text: label || '(untitled)', title: label }),
    actions(path, item),
  ]);
  dragHandlers(row, path, item);
  const children = isContainer(item) && item.items?.length
    // eslint-disable-next-line no-use-before-define
    ? renderItems(item.items, path) : null;
  return h('li', { role: 'none' }, [row, children]);
}

function renderItems(items, base) {
  return h('ul', { class: 'fe-tree', role: base.length ? 'group' : 'tree' }, items.map((item, i) => renderRow([...base, i], item)));
}

function renderOutline() {
  const { model } = state.form;
  const root = h('div', {
    class: `fe-row fe-root${state.selected?.length === 0 ? ' is-selected' : ''}`,
    tabIndex: 0,
    'data-key': 'row:',
    onclick: () => {
      state.selected = [];
      // eslint-disable-next-line no-use-before-define
      render();
    },
    ondblclick: () => {
      // eslint-disable-next-line no-use-before-define
      openProperties([]);
    },
    onkeydown: (e) => onRowKey(e, []),
  }, [
    h('span', { class: 'fe-type', text: 'Form' }),
    h('span', { class: 'fe-label fe-form-title', text: plainText(model.title) || model.name || 'Untitled form' }),
    h('span', { class: 'fe-actions' }, h('button', {
      type: 'button',
      class: 'fe-action fe-action-wrench',
      title: 'Form properties',
      'aria-label': 'Form properties',
      icon: 'wrench',
      tabIndex: -1,
      onclick: (e) => {
        e.stopPropagation();
        // eslint-disable-next-line no-use-before-define
        openProperties([]);
      },
    })),
  ]);
  dragHandlers(root, [], model);
  const items = model.items.length
    ? renderItems(model.items, [])
    : h('div', { class: 'fe-empty' }, [
      h('p', { class: 'fe-muted', text: 'This form has no items yet.' }),
      h('button', {
        type: 'button', class: 'nx-btn-primary', text: 'Add a component', disabled: !state.live?.editable || state.busy, onclick: () => openInsert([]),
      }),
    ]);
  return h('div', { class: 'fe-outline' }, [root, items]);
}

/* ---------- Property sheet ---------- */

function openProperties(path) {
  state.selected = path;
  state.view = 'properties';
  state.fieldErrors = new Map();
  state.jsonDraft = undefined;
  // eslint-disable-next-line no-use-before-define
  render();
}

// Replace the item at `path` with `next`; for the form ([]), its settings (its items stay).
function replaceAt(model, path, next) {
  if (!path.length) {
    const { items } = model;
    Object.keys(model).forEach((key) => { delete model[key]; });
    Object.assign(model, next, { items });
    return;
  }
  removeItem(model, path);
  insertItem(model, path.slice(0, -1), next, path.at(-1));
}

// What a property sheet edits: an item, or the form's settings (without its items).
function sheetValue(model, path) {
  if (path.length) return itemAt(model, path);
  const { items, ...settings } = model;
  return settings;
}

function commitField(path, field, value) {
  const error = validateField(field, value);
  if (error) {
    state.fieldErrors.set(field.name, { message: error, value });
    // eslint-disable-next-line no-use-before-define
    render();
    return;
  }
  state.fieldErrors.delete(field.name);
  edit((model) => {
    const item = sheetValue(model, path);
    const next = writeField(item, field, value);
    if (JSON.stringify(next) === JSON.stringify(item)) return false;
    replaceAt(model, path, next);
    return undefined;
  });
}

function fieldControl(field, value, id, commit, disabled) {
  const options = (field.options || []).map((o) => (typeof o === 'object' ? o : { name: o, value: o }));
  if (field.component === 'select' || field.component === 'radio-group') {
    const known = options.some((o) => String(o.value) === String(value ?? ''));
    const select = h('select', {
      id, class: 'nx-input', disabled, onchange: () => commit(select.value),
    }, [
      options.some((o) => o.value === '') ? null : h('option', { value: '', text: '—' }),
      ...options.map((o) => h('option', { value: o.value, text: o.name ?? o.value })),
      known || value === undefined || value === '' ? null : h('option', { value, text: String(value) }),
    ]);
    select.value = value === undefined || value === null ? '' : String(value);
    return select;
  }
  if (field.multi && !['number', 'boolean'].includes(field.component)) {
    return h('textarea', {
      id, class: 'nx-input', rows: 4, disabled, placeholder: 'One value per line', value: [value ?? []].flat().join('\n'), onchange: (e) => commit(e.target.value.split('\n').map((v) => v.trim()).filter(Boolean)),
    });
  }
  if (field.component === 'richtext') {
    return h('textarea', {
      id, class: 'nx-input', rows: 3, disabled, value: value ?? '', onchange: (e) => commit(e.target.value),
    });
  }
  if (field.component === 'number') {
    return h('input', {
      id,
      type: 'number',
      class: 'nx-input',
      disabled,
      value: value ?? '',
      placeholder: field.placeholder,
      onchange: (e) => {
        const raw = e.target.value;
        if (raw === '') commit('');
        else commit(field.valueType === 'string' ? raw : Number(raw));
      },
    });
  }
  return h('input', {
    id,
    type: field.component === 'date-time' ? 'date' : 'text',
    class: 'nx-input',
    disabled,
    value: value === undefined || value === null ? '' : String(value),
    placeholder: field.placeholder,
    onchange: (e) => commit(e.target.value.trim()),
  });
}

function renderField(field, item, path, disabled) {
  const id = `fe-field-${field.name.replace(/[^\w-]/g, '_')}`;
  const value = readField(item, field);
  const commit = (next) => commitField(path, field, next);
  const help = field.description ? h('p', { class: 'fe-help', text: plainText(field.description) }) : null;
  if (field.component === 'boolean') {
    const input = h('input', {
      id, type: 'checkbox', checked: value === true, disabled, onchange: () => commit(input.checked),
    });
    return h('div', { class: 'fe-field fe-check', 'data-key': `field:${field.name}` }, [
      h('label', { class: 'nx-checkbox' }, [input, h('span', { text: field.label || field.name })]),
      help,
    ]);
  }
  if (field.component === 'container') {
    return h('p', { class: 'fe-help', text: plainText(field.label || field.description) });
  }
  const error = state.fieldErrors.get(field.name);
  const control = fieldControl(field, error ? error.value : value, id, commit, disabled);
  if (error) control.setAttribute('aria-invalid', 'true');
  return h('div', { class: `fe-field${error ? ' has-error' : ''}`, 'data-key': `field:${field.name}` }, [
    h('label', { for: id, class: 'fe-field-label' }, [
      field.label || field.name,
      field.required ? h('span', { class: 'fe-required', text: '*', 'aria-hidden': 'true' }) : null,
    ]),
    control,
    error ? h('p', { class: 'fe-error', text: error.message }) : null,
    help,
  ]);
}

function renderJson(item, path, disabled) {
  const textarea = h('textarea', {
    id: 'fe-json',
    class: 'nx-input fe-code',
    spellcheck: false,
    disabled,
    value: state.jsonDraft ?? JSON.stringify(item, null, 2),
    oninput: (e) => { state.jsonDraft = e.target.value; },
  });
  const apply = () => {
    let next;
    try {
      next = JSON.parse(textarea.value);
      if (!next || typeof next !== 'object' || Array.isArray(next)) throw new Error('The JSON must be an object.');
    } catch (error) {
      setMessage(`Invalid JSON: ${error.message}`);
      return;
    }
    state.jsonDraft = undefined;
    edit((model) => {
      replaceAt(model, path, next);
      return undefined;
    });
  };
  return h('div', { class: 'fe-field', 'data-key': 'field::json' }, [
    h('label', { for: 'fe-json', class: 'fe-field-label', text: path.length ? 'JSON of this item' : 'JSON of the form settings (its items are kept)' }),
    textarea,
    disabled ? null : h('div', { class: 'fe-buttons' }, [
      h('button', {
        type: 'button',
        class: 'nx-action-btn',
        text: 'Reset',
        onclick: () => {
          state.jsonDraft = undefined;
          // eslint-disable-next-line no-use-before-define
          render();
        },
      }),
      h('button', {
        type: 'button', class: 'nx-btn-accent', text: 'Apply', onclick: apply,
      }),
    ]),
  ]);
}

// Form › Panel › … › this item: each ancestor opens its own property sheet.
function renderBreadcrumb(path) {
  const { model } = state.form;
  const crumbs = [{ path: [], label: plainText(model.title) || 'Form' }];
  path.forEach((index, depth) => {
    const at = path.slice(0, depth + 1);
    crumbs.push({ path: at, label: describeItem(itemAt(model, at), state.components).label || '(untitled)' });
  });
  const items = crumbs.map((crumb, i) => {
    const current = i === crumbs.length - 1;
    return h('li', {}, current
      ? h('span', { class: 'fe-crumb-current', 'aria-current': 'location', text: crumb.label })
      : h('button', {
        type: 'button',
        class: 'fe-crumb',
        text: crumb.label,
        title: crumb.label,
        onclick: () => openProperties(crumb.path),
      }));
  });
  return h('nav', { class: 'fe-breadcrumb', 'aria-label': 'Hierarchy' }, h('ol', {}, items));
}

function renderProperties() {
  const path = state.selected;
  const item = path ? sheetValue(state.form.model, path) : null;
  if (!item) {
    state.view = 'outline';
    return renderOutline();
  }
  const component = path.length ? componentFor(item, state.components) : FORM_COMPONENT;
  const fields = component?.fields ?? [];
  const tabs = [...tabsOf(fields), { label: 'JSON', json: true }];
  state.tab = Math.min(state.tab, tabs.length - 1);
  const tab = tabs[state.tab];
  const disabled = !state.live?.editable || state.busy;
  const body = tab.json
    ? [renderJson(item, path, disabled)]
    : tab.fields.filter((field) => field?.name && field.component !== 'edit-fragment')
      .filter((field) => isShown(field, item, fields))
      .map((field) => renderField(field, item, path, disabled));
  return h('div', { class: 'fe-properties' }, [
    // eslint-disable-next-line no-use-before-define
    renderBreadcrumb(path),
    h('div', { class: 'fe-props-head' }, [
      h('button', {
        type: 'button',
        class: 'fe-back',
        title: 'Back to the outline',
        'aria-label': 'Back to the outline',
        icon: 'back',
        onclick: () => {
          state.view = 'outline';
          // eslint-disable-next-line no-use-before-define
          render();
        },
      }),
      h('div', {}, [
        h('h2', { text: component?.title ?? item.fieldType ?? 'Item' }),
        h('p', { class: 'fe-muted', text: path.length ? describeItem(item, state.components).label : plainText(item.title) }),
      ]),
    ]),
    h('div', { class: 'fe-tabs', role: 'tablist' }, tabs.map((t, i) => h('button', {
      type: 'button',
      role: 'tab',
      class: `fe-tab${i === state.tab ? ' is-selected' : ''}`,
      'aria-selected': String(i === state.tab),
      text: t.label,
      onclick: () => {
        state.tab = i;
        // eslint-disable-next-line no-use-before-define
        render();
      },
    }))),
    h('div', { class: 'fe-props-body', role: 'tabpanel' }, body),
  ]);
}

/* ---------- Rendering ---------- */

function render() {
  const focused = document.activeElement?.closest?.('[data-key]')?.dataset.key;
  const scroll = app.scrollTop;
  let content;
  if (!state.sdk) content = h('p', { class: 'fe-muted fe-empty', text: 'Connecting to DA…' });
  else if (state.form?.error) content = h('p', { class: 'fe-error fe-empty', text: state.form.error });
  else if (!state.form) {
    content = h('div', { class: 'fe-hint' }, [
      h('h2', { text: 'Form Editor' }),
      h('p', { class: 'fe-muted', text: 'Place the cursor in a form block to edit its form.' }),
    ]);
  } else {
    content = state.view === 'properties' ? renderProperties() : renderOutline();
  }
  const status = state.message ? h('p', { class: 'fe-status', role: 'alert', text: state.message }) : null;
  const readOnly = state.form && state.live && !state.live.editable
    ? h('p', { class: 'fe-status fe-info', text: 'The document is read-only.' }) : null;
  app.replaceChildren(...[readOnly, status, content].filter(Boolean));
  app.scrollTop = scroll;
  if (focused) {
    const target = app.querySelector(`[data-key="${CSS.escape(focused)}"]`);
    (target?.matches('input, select, textarea, [tabindex]') ? target : target?.querySelector('input, select, textarea'))?.focus();
  }
}

/* ---------- Live document ---------- */

function receive({ html, selection, editable }) {
  const blockIndex = selection?.blockIndex ?? null;
  const previous = state.form;
  // A save error is about the document it failed on.
  if (html !== state.live?.html) state.message = '';
  state.live = { html, blockIndex, editable: editable !== false };
  const form = blockIndex === null ? null : readFormBlock(html, blockIndex);
  state.form = form;
  if (!form?.model) {
    state.view = 'outline';
    state.selected = null;
  } else if (previous?.model && state.selected && !itemAt(form.model, state.selected)) {
    state.selected = null;
    state.view = 'outline';
  }
  render();
}

async function init() {
  render();
  let sdk;
  try {
    sdk = await DA_SDK;
  } catch (error) {
    app.replaceChildren(h('p', { class: 'fe-error fe-empty', text: `Could not connect to DA: ${error.message}` }));
    return;
  }
  if (sdk.capabilities?.liveDocument !== 1 || typeof sdk.actions?.subscribeLiveDocument !== 'function') {
    app.replaceChildren(h('p', { class: 'fe-error fe-empty', text: 'This version of DA doesn’t share the live document with extensions.' }));
    return;
  }
  state.sdk = sdk;
  state.components = await loadComponents();
  sdk.actions.subscribeLiveDocument(receive);
  render();
}

init();
