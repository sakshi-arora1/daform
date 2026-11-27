/*
 * Model-driven inspector for the form block operator: the selected item's properties, as the
 * Universal Editor component models in blocks/form/models describe them (tabs from the models'
 * `tab` fields, `...` references resolved). Mirrors the Block Inspector of the formeditor app.
 */
import { createElement as h, plainText } from './shared.js';

const MODELS_URL = new URL('../../blocks/form/models/form-components/', import.meta.url);

/** fieldType (or :type) of an item → component model file in blocks/form/models/form-components. */
const MODEL_FILES = {
  'text-input': '_text-input.json',
  text: '_text-input.json',
  email: '_email.json',
  'number-input': '_number-input.json',
  number: '_number-input.json',
  'drop-down': '_drop-down.json',
  select: '_drop-down.json',
  'radio-group': '_radio-group.json',
  radio: '_radio-group.json',
  'checkbox-group': '_checkbox-group.json',
  checkbox: '_checkbox.json',
  'date-input': '_date-input.json',
  date: '_date-input.json',
  'file-input': '_file-input.json',
  file: '_file-input.json',
  'multiline-input': '_multiline-input.json',
  'text-area': '_multiline-input.json',
  textarea: '_multiline-input.json',
  'telephone-input': '_telephone-input.json',
  tel: '_telephone-input.json',
  button: '_button.json',
  'submit-button': '_submit-button.json',
  submit: '_submit-button.json',
  'reset-button': '_reset-button.json',
  reset: '_reset-button.json',
  'plain-text': '_text.json',
  heading: '_text.json',
  image: '_image.json',
  panel: '_panel.json',
  captcha: '_recaptcha.json',
};
const FALLBACK_FILE = '_text-input.json';
const FALLBACK_TITLES = { '_multiline-input.json': 'Multiline Input' };

/** Model field name → path in the AF item (as the formeditor's property forms bind them). */
const PATHS = {
  'jcr:title': ['label', 'value'],
  hideTitle: ['label', 'visible'],
  mandatoryMessage: ['constraintMessages', 'required'],
  minLengthMessage: ['constraintMessages', 'minLength'],
  maxLengthMessage: ['constraintMessages', 'maxLength'],
  validatePictureClauseMessage: ['constraintMessages', 'pattern'],
  validateExpMessage: ['constraintMessages', 'validationExpression'],
  minimumMessage: ['constraintMessages', 'minimum'],
  maximumMessage: ['constraintMessages', 'maximum'],
  maxFileSizeMessage: ['constraintMessages', 'maxFileSize'],
  acceptMessage: ['constraintMessages', 'accept'],
  minimumDate: ['minimum'],
  maximumDate: ['maximum'],
  orientation: ['properties', 'afs:layout', 'orientation'],
};
const TOP_LEVEL = new Set([
  'name', 'dataRef', 'visible', 'enabled', 'readOnly', 'required', 'placeholder', 'default',
  'description', 'tooltip', 'pattern', 'minLength', 'maxLength', 'minimum', 'maximum', 'enum',
  'enumNames', 'minOccur', 'maxOccur', 'accept', 'maxFileSize', 'displayFormat', 'altText', 'type',
  'value',
]);
const INVERTED = new Set(['hideTitle']);
const TEXT_LIKE = new Set(['text', 'datasource-bindref', 'aem-content', 'reference']);
const HIDDEN = new Set(['edit-fragment']);

export const pathOf = (name) => {
  if (PATHS[name]) return PATHS[name];
  return TOP_LEVEL.has(name) ? [name] : ['properties', name];
};

const getPath = (obj, path) => path.reduce((value, key) => value?.[key], obj);

function setPath(obj, path, value) {
  const parents = [obj];
  let node = obj;
  path.slice(0, -1).forEach((key) => {
    if (!node[key] || typeof node[key] !== 'object') node[key] = {};
    node = node[key];
    parents.push(node);
  });
  const last = path[path.length - 1];
  if (value === undefined) delete node[last];
  else node[last] = value;
  // Drop objects this left empty (e.g. `constraintMessages`), but never the item itself.
  for (let i = path.length - 1; i > 0; i -= 1) {
    if (Object.keys(parents[i]).length) break;
    delete parents[i - 1][path[i - 1]];
  }
}

/** The value a model field shows for an item (the model's `value` is its default). */
export function readValue(item, field) {
  const raw = getPath(item, pathOf(field.name));
  if (INVERTED.has(field.name)) return raw === false;
  return raw === undefined ? field.value : raw;
}

/** A copy of `item` with a model field set; empty values remove the property. */
export function writeValue(item, field, value) {
  const next = structuredClone(item);
  const path = pathOf(field.name);
  let stored = value;
  if (INVERTED.has(field.name)) stored = value ? false : undefined;
  else if (field.component === 'boolean') {
    // Unchecking stores false only when the model defaults to true; otherwise it removes the key.
    if (value) stored = true;
    else stored = field.value === true ? false : undefined;
  } else if (stored === '' || (Array.isArray(stored) && !stored.length)) stored = undefined;
  setPath(next, path, stored);
  return next;
}

const modelCache = new Map();

async function fetchJson(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`${resp.status} loading ${url}`);
  return resp.json();
}

/** Resolve `{ "...": "file.json#/pointer" }` entries in a field list, recursively. */
async function expandFields(fields, base) {
  const lists = await Promise.all((fields || []).map(async (field) => {
    if (!field?.['...']) return [field];
    const [file, pointer = ''] = field['...'].split('#');
    const url = new URL(file, base);
    const json = await fetchJson(url);
    const target = pointer.split('/').filter(Boolean).reduce((value, key) => value?.[key], json);
    return expandFields(Array.isArray(target) ? target : [], url);
  }));
  return lists.flat();
}

/** File name of the component model for an item. */
export function modelFileFor(item) {
  const click = JSON.stringify(item?.events?.click ?? '');
  if (item?.fieldType === 'button') {
    if (item.buttonType === 'submit' || /submitForm/.test(click)) return '_submit-button.json';
    if (item.buttonType === 'reset' || /reset\(/.test(click)) return '_reset-button.json';
  }
  return MODEL_FILES[item?.[':type']] || MODEL_FILES[item?.fieldType] || FALLBACK_FILE;
}

/** `{ title, fields }` of a component model file, fetched once. */
export function loadModel(file, base = MODELS_URL) {
  const url = new URL(file, base).href;
  if (!modelCache.has(url)) {
    modelCache.set(url, (async () => {
      const json = await fetchJson(url);
      const model = json.models?.[0];
      const definition = json.definitions?.find((d) => d.id === model?.id) || json.definitions?.[0];
      return {
        title: definition?.title || FALLBACK_TITLES[file] || model?.id || 'Component',
        fields: await expandFields(model?.fields, url),
      };
    })().catch((error) => {
      modelCache.delete(url);
      throw error;
    }));
  }
  return modelCache.get(url);
}

/** Split model fields into tabs at `component: tab` entries. */
export function tabsOf(fields) {
  const tabs = [];
  fields.forEach((field) => {
    if (field.component === 'tab') {
      tabs.push({ label: field.label || field.name, fields: [] });
      return;
    }
    if (!tabs.length) tabs.push({ label: 'Basic', fields: [] });
    tabs[tabs.length - 1].fields.push(field);
  });
  return tabs.filter((tab) => tab.fields.length);
}

/** Evaluate a model field's json-logic `condition` against the item. */
export function isShown(condition, item, fields) {
  if (!condition) return true;
  const byName = new Map(fields.map((f) => [f.name, f]));
  const evaluate = (node) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return node;
    const [[op, args]] = Object.entries(node);
    const list = [args].flat();
    switch (op) {
      case 'var': {
        const field = byName.get(list[0]) ?? { name: list[0] };
        return readValue(item, field);
      }
      case '===': case '==': return evaluate(list[0]) === evaluate(list[1]);
      case '!==': case '!=': return evaluate(list[0]) !== evaluate(list[1]);
      case 'and': return list.every((n) => evaluate(n));
      case 'or': return list.some((n) => evaluate(n));
      case '!': return !evaluate(list[0]);
      default: return true;
    }
  };
  return !!evaluate(condition);
}

function validate(field, value) {
  const empty = value === undefined || value === '' || (Array.isArray(value) && !value.length);
  if (field.required && empty) return `${field.label || field.name} is required.`;
  const regExp = field.validation?.regExp;
  if (regExp && !empty && !new RegExp(regExp).test(String(value))) {
    return field.validation.customErrorMsg || 'The value is not valid.';
  }
  return null;
}

function renderControl(doc, field, value, { id, disabled, commit }) {
  const { component } = field;
  const options = (field.options || []).map((o) => (typeof o === 'object' ? o : { name: o, value: o }));
  if (component === 'select' || component === 'radio-group') {
    const known = options.some((o) => String(o.value) === String(value ?? ''));
    const choices = [
      ...(options.some((o) => o.value === '') ? [] : [h(doc, 'option', { value: '', text: '—' })]),
      ...options.map((o) => h(doc, 'option', { value: o.value, text: o.name ?? o.value })),
      ...(known || value === undefined || value === '' ? [] : [h(doc, 'option', { value, text: String(value) })]),
    ];
    const select = h(doc, 'select', { id, disabled, onchange: () => commit(select.value) }, choices);
    select.value = value === undefined ? '' : String(value);
    return select;
  }
  if (field.multi && TEXT_LIKE.has(component)) {
    return h(doc, 'textarea', {
      id,
      rows: 4,
      disabled,
      placeholder: 'One value per line',
      value: [value ?? []].flat().join('\n'),
      onchange: (e) => commit(e.target.value.split('\n').map((v) => v.trim()).filter(Boolean)),
    });
  }
  if (component === 'richtext') {
    return h(doc, 'textarea', {
      id, rows: 3, disabled, value: value ?? '', onchange: (e) => commit(e.target.value),
    });
  }
  if (component === 'number') {
    return h(doc, 'input', {
      id,
      type: 'number',
      disabled,
      value: value ?? '',
      placeholder: field.placeholder || '',
      onchange: (e) => {
        const raw = e.target.value;
        if (raw === '') commit('');
        else commit(field.valueType === 'string' ? raw : Number(raw));
      },
    });
  }
  if (component === 'date-time') {
    return h(doc, 'input', {
      id, type: 'date', disabled, value: value ?? '', onchange: (e) => commit(e.target.value),
    });
  }
  return h(doc, 'input', {
    id,
    type: 'text',
    disabled,
    value: value === undefined || value === null ? '' : String(value),
    placeholder: field.placeholder || '',
    onchange: (e) => commit(e.target.value.trim()),
  });
}

function renderField(doc, field, item, ctx) {
  const id = `bo-f-${field.name.replace(/[^\w-]/g, '_')}`;
  const value = readValue(item, field);
  const help = field.description ? h(doc, 'p', { class: 'help', text: field.description }) : '';
  if (field.component === 'boolean') {
    const input = h(doc, 'input', {
      id,
      type: 'checkbox',
      checked: value === true,
      disabled: ctx.disabled,
      onchange: () => ctx.apply(field, input.checked),
    });
    return h(doc, 'div', { class: 'field field-boolean', 'data-key': field.name }, [
      h(doc, 'label', { class: 'bo-check' }, [input, h(doc, 'span', { text: field.label || field.name })]),
      help,
    ]);
  }
  if (field.component === 'container') {
    return h(doc, 'p', { class: 'help', text: plainText(field.label || field.description) });
  }
  const error = ctx.errors.get(field.name);
  const control = renderControl(doc, field, error ? error.value : value, {
    id, disabled: ctx.disabled, commit: (next) => ctx.apply(field, next),
  });
  control.classList.add('nx-input');
  if (error) control.setAttribute('aria-invalid', 'true');
  const label = h(doc, 'label', { class: 'field-label', htmlFor: id }, [field.label || field.name]);
  if (field.required) label.append(h(doc, 'span', { class: 'required', text: '*', ariaHidden: 'true' }));
  return h(doc, 'div', { class: `field${error ? ' has-error' : ''}`, 'data-key': field.name }, [
    label,
    control,
    error ? h(doc, 'p', { class: 'field-error', text: error.message }) : '',
    help,
  ]);
}

function renderJson(doc, item, ctx) {
  const textarea = h(doc, 'textarea', {
    id: 'bo-json',
    class: 'nx-input code',
    rows: 18,
    spellcheck: false,
    disabled: ctx.disabled,
    value: ctx.jsonDraft ?? JSON.stringify(item, null, 2),
    oninput: (e) => { ctx.setJsonDraft(e.target.value); },
  });
  const error = ctx.jsonError ? h(doc, 'p', { class: 'field-error', role: 'alert', text: ctx.jsonError }) : '';
  const apply = () => {
    try {
      const parsed = JSON.parse(textarea.value);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('The JSON must be an object.');
      ctx.replace(parsed);
    } catch (e) {
      ctx.setJsonError(e.message);
    }
  };
  return h(doc, 'div', { class: 'field json-field', 'data-key': ':json' }, [
    h(doc, 'label', { class: 'field-label', htmlFor: 'bo-json', text: 'JSON of this item' }),
    textarea,
    error,
    ctx.disabled ? '' : h(doc, 'div', { class: 'bo-actions' }, [
      h(doc, 'button', {
        type: 'button', class: 'nx-action-btn', text: 'Reset', onclick: () => ctx.setJsonDraft(undefined, true),
      }),
      h(doc, 'button', {
        type: 'button', class: 'nx-btn-accent', text: 'Apply', onclick: apply,
      }),
    ]),
  ]);
}

export const INSPECTOR_CSS = `
.bo-inspector-head { padding: 4px 0 8px; }
.bo-inspector-head h2 { margin: 0; font-size: 16px; }
.bo-inspector-sub, .help, .bo-note { margin: 0; color: var(--s2-gray-600, #8f8f8f); font-size: 12px; }
.bo-tabs { display: flex; flex-wrap: wrap; gap: 12px; border-bottom: 1px solid var(--s2-gray-100, #e9e9e9); }
.bo-tab {
  padding: 6px 0 4px; border: none; border-bottom: 2px solid transparent; background: none;
  color: var(--s2-gray-700, #6d6d6d); font: inherit; font-size: 12px; font-weight: 500; cursor: pointer;
}
.bo-tab.is-selected { border-bottom-color: var(--s2-gray-800, #464646); color: var(--s2-gray-900, #131313); font-weight: 700; }
.bo-tab:focus-visible { outline: 2px solid var(--s2-blue-800, #3b63fb); outline-offset: 2px; }
.bo-inspector-body { display: flex; flex-direction: column; gap: 12px; padding: 12px 0 24px; }
.field { display: flex; flex-direction: column; gap: 4px; }
.field-label { color: var(--s2-gray-700, #6d6d6d); font-size: 12px; }
.field-label .required { margin-inline-start: 2px; }
.field input[type='text'], .field input[type='number'], .field input[type='date'], .field select, .field textarea {
  box-sizing: border-box; width: 100%; min-height: 32px; padding: 5px 10px; font: inherit;
  border: 2px solid var(--s2-gray-300, #dadada); border-radius: 8px; background: var(--s2-gray-25, #fff);
}
.field textarea { resize: vertical; min-height: 120px; }
.field-boolean { align-items: flex-start; }
.field-boolean .bo-check {
  display: inline-flex; flex-direction: row; align-items: center; justify-content: flex-start;
  gap: 8px; width: auto; text-align: start; cursor: pointer;
}
.field-boolean .bo-check input[type='checkbox'] { flex: none; width: 16px; height: 16px; margin: 0; }
.field textarea.code {
  min-height: 24em; font-family: 'Source Code Pro', Menlo, monospace; font-size: 12px; white-space: pre;
}
.field.has-error input, .field.has-error textarea, .field.has-error select { border-color: var(--s2-red-900, #d73220); }
.field-error { margin: 0; color: var(--s2-red-900, #d73220); font-size: 12px; }
.switch { display: flex; align-items: center; gap: 8px; cursor: pointer; }
.switch input { width: 16px; height: 16px; margin: 0; }
.json-field .bo-actions { justify-content: flex-end; }
`;

/**
 * Model-driven inspector for one form, rendered into `root`. Call `render()` whenever the item,
 * the selection or editability changes. `opts`: `{ getItem() → { item, pointer } | null,
 * editable(), commitItem(pointer, item) → Promise<result> }`.
 */
export function createModelInspector(root, opts) {
  const doc = root.ownerDocument;
  const view = {
    pointer: null, tab: 0, errors: new Map(), jsonDraft: undefined, jsonError: '', model: null, file: null,
  };
  let renderedItem = null;

  const render = () => {
    const current = opts.getItem();
    if (!current) {
      view.pointer = null;
      root.replaceChildren(h(doc, 'p', { class: 'bo-note', text: 'Select a field in the outline, the document or the preview.' }));
      return;
    }
    const { item, pointer } = current;
    if (pointer !== view.pointer) {
      Object.assign(view, {
        pointer, errors: new Map(), jsonDraft: undefined, jsonError: '',
      });
    }
    renderedItem = item;
    const file = modelFileFor(item);
    if (view.file !== file) {
      view.file = file;
      view.tab = 0;
      view.model = null;
      loadModel(file).then((model) => {
        if (view.file !== file) return;
        view.model = model;
        render();
      }).catch((error) => {
        if (view.file !== file) return;
        view.model = { title: item.fieldType || 'Item', fields: [], error: error.message };
        render();
      });
    }

    const focused = root.getRootNode().activeElement?.closest?.('[data-key]')?.dataset.key;
    const disabled = !opts.editable();
    const { model } = view;
    const tabs = model ? tabsOf(model.fields) : [];
    tabs.push({ label: 'JSON', json: true });
    // Don't overwrite the chosen tab while the model loads (only JSON exists then).
    const activeIndex = model ? Math.min(view.tab, tabs.length - 1) : tabs.length - 1;
    const active = tabs[activeIndex];

    const commit = async (next) => {
      const result = await opts.commitItem(pointer, next);
      if (result && !result.ok) {
        view.jsonError = `Could not save: ${result.message || result.error}`;
        render();
      }
      return result;
    };
    const ctx = {
      disabled,
      errors: view.errors,
      jsonDraft: view.jsonDraft,
      jsonError: view.jsonError,
      apply(field, value) {
        const error = validate(field, value);
        if (error) {
          view.errors.set(field.name, { message: error, value });
          render();
          return;
        }
        view.errors.delete(field.name);
        const next = writeValue(renderedItem, field, value);
        if (JSON.stringify(next) === JSON.stringify(renderedItem)) {
          render();
          return;
        }
        commit(next);
      },
      replace(next) {
        view.jsonDraft = undefined;
        view.jsonError = '';
        commit(next);
      },
      setJsonDraft(value, rerender) {
        view.jsonDraft = value;
        view.jsonError = '';
        if (rerender) render();
      },
      setJsonError(message) {
        view.jsonError = message;
        render();
      },
    };

    let body;
    if (!model) body = [h(doc, 'p', { class: 'bo-note', text: 'Loading the component model…' })];
    else if (active.json) body = [renderJson(doc, item, ctx)];
    else {
      body = active.fields
        .filter((field) => field.name && !HIDDEN.has(field.component))
        .filter((field) => isShown(field.condition, item, model.fields))
        .map((field) => renderField(doc, field, item, ctx));
    }

    const tabButtons = tabs.map((tab, index) => h(doc, 'button', {
      type: 'button',
      role: 'tab',
      class: `bo-tab${index === activeIndex ? ' is-selected' : ''}`,
      ariaSelected: String(index === activeIndex),
      text: tab.label,
      onclick: () => {
        view.tab = index;
        render();
      },
    }));

    root.replaceChildren(h(doc, 'div', { class: 'bo-inspector' }, [
      h(doc, 'div', { class: 'bo-inspector-head' }, [
        h(doc, 'h2', { text: model?.title || item.fieldType || 'Item' }),
        h(doc, 'p', { class: 'bo-inspector-sub', text: plainText(item.label?.value) || item.name || '' }),
      ]),
      model?.error ? h(doc, 'p', { class: 'field-error', text: `No component model: ${model.error}. Edit it as JSON.` }) : '',
      h(doc, 'div', { class: 'bo-tabs', role: 'tablist', ariaLabel: 'Property groups' }, tabButtons),
      h(doc, 'div', { class: 'bo-inspector-body', role: 'tabpanel' }, body),
    ]));
    if (focused) root.querySelector(`[data-key="${CSS.escape(focused)}"] :is(input, select, textarea)`)?.focus();
  };

  return { render };
}
