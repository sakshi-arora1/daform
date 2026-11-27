/*
 * Form Editor: the form components and their property sheets, from the Universal Editor
 * component models in blocks/form/models (fetched from the site; `...` references resolved).
 */
import { plainText, uniqueName, usedNames } from './form-model.js';

export const MODELS_URL = new URL('../../blocks/form/models/form-components/', import.meta.url);

// Component model files (a site can't list a folder over HTTP).
export const MODEL_FILES = [
  '_text-input.json', '_multiline-input.json', '_email.json', '_telephone-input.json',
  '_number-input.json', '_date-input.json', '_drop-down.json', '_radio-group.json',
  '_checkbox-group.json', '_checkbox.json', '_file-input.json', '_text.json', '_image.json',
  '_panel.json', '_button.json', '_submit-button.json', '_reset-button.json', '_recaptcha.json',
  '_fragment.json',
];

// Components offered by Insert (a fragment needs an AEM form to point to).
const NOT_INSERTABLE = new Set(['form-fragment']);

// An item's fieldType (or :type) → component id, for values the models don't use.
const ALIASES = {
  text: 'text-input',
  'text-area': 'multiline-input',
  textarea: 'multiline-input',
  tel: 'telephone-input',
  select: 'drop-down',
  radio: 'radio-group',
  date: 'date-input',
  number: 'number-input',
  file: 'file-input',
  heading: 'plain-text',
  image: 'form-image',
};
const FALLBACK = 'text-input';

/* ---------- Loading ---------- */

const cache = new Map();

async function fetchJson(url) {
  if (!cache.has(url.href)) {
    cache.set(url.href, fetch(url).then((resp) => {
      if (!resp.ok) throw new Error(`${resp.status} loading ${url.href}`);
      return resp.json();
    }).catch((error) => {
      cache.delete(url.href);
      throw error;
    }));
  }
  return cache.get(url.href);
}

/** Resolve `{ "...": "file.json#/pointer" }` entries of a field list, recursively. */
export async function expandFields(fields, base) {
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

/**
 * Every component: `{ id, title, template, fields, file, insertable }`. One model file can hold
 * several models; a model without a definition (multiline input) is still editable.
 */
export async function loadComponents(base = MODELS_URL) {
  const files = await Promise.all(MODEL_FILES.map(async (file) => {
    const url = new URL(file, base);
    try {
      const json = await fetchJson(url);
      return Promise.all((json.models || []).map(async (model) => {
        const definition = (json.definitions || []).find((d) => d.id === model.id);
        const template = definition?.plugins?.xwalk?.page?.template ?? null;
        return {
          id: model.id,
          title: definition?.title || model.id.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase()),
          template,
          fields: await expandFields(model.fields, url),
          file,
          insertable: !!template && !NOT_INSERTABLE.has(model.id),
        };
      }));
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn('[form-editor] could not load', url.href, error);
      return [];
    }
  }));
  return files.flat();
}

/** The component of an item. */
export function componentFor(item, components) {
  const byId = new Map(components.map((c) => [c.id, c]));
  if (item?.fieldType === 'button') {
    const click = JSON.stringify(item.events?.click ?? '');
    if (item.buttonType === 'submit' || /submitForm/.test(click)) return byId.get('form-submit-button');
    if (item.buttonType === 'reset' || /reset\(/.test(click)) return byId.get('form-reset-button');
    return byId.get('form-button');
  }
  const keys = [item?.[':type'], item?.fieldType].filter(Boolean);
  const id = keys.map((key) => (byId.has(key) ? key : ALIASES[key])).find((key) => byId.has(key));
  return byId.get(id) ?? byId.get(FALLBACK);
}

/* ---------- Model field ↔ item property ---------- */

// Model field name → path in the AF item. Unlisted names in TOP_LEVEL are top-level; any
// other name goes under `properties`.
const PATHS = {
  'jcr:title': ['label', 'value'],
  hideTitle: ['label', 'visible'],
  textIsRich: ['richText'],
  checkedValue: ['enum', 0],
  uncheckedValue: ['enum', 1],
  orientation: ['properties', 'afs:layout', 'orientation'],
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
};
const TOP_LEVEL = new Set([
  'name', 'dataRef', 'visible', 'enabled', 'readOnly', 'required', 'placeholder', 'default',
  'description', 'tooltip', 'pattern', 'minLength', 'maxLength', 'minimum', 'maximum', 'enum',
  'enumNames', 'minOccur', 'maxOccur', 'accept', 'maxFileSize', 'displayFormat', 'altText', 'type',
  'value', 'buttonType', 'repeatable',
]);
// Booleans stored inverted (the model's "Hide title" is `label.visible: false`).
const INVERTED = new Set(['hideTitle']);

export function pathOf(name) {
  if (PATHS[name]) return PATHS[name];
  return TOP_LEVEL.has(name) ? [name] : ['properties', name];
}

const getPath = (obj, path) => path.reduce((value, key) => value?.[key], obj);

function setPath(obj, path, value) {
  const parents = [obj];
  let node = obj;
  path.slice(0, -1).forEach((key, i) => {
    if (node[key] === null || typeof node[key] !== 'object') {
      node[key] = typeof path[i + 1] === 'number' ? [] : {};
    }
    node = node[key];
    parents.push(node);
  });
  const last = path.at(-1);
  if (value !== undefined) {
    node[last] = value;
    return;
  }
  if (Array.isArray(node)) node.splice(last, 1);
  else delete node[last];
  // Drop the containers this left empty (e.g. `constraintMessages`), never the item itself.
  for (let i = path.length - 1; i > 0; i -= 1) {
    const container = parents[i];
    if (Array.isArray(container) ? container.length : Object.keys(container).length) break;
    delete parents[i - 1][path[i - 1]];
  }
}

/** The value a field shows for an item (the model's `value` is its default). */
export function readField(item, field) {
  const raw = getPath(item, pathOf(field.name));
  if (INVERTED.has(field.name)) return raw === false;
  return raw === undefined ? field.value : raw;
}

/** A copy of `item` with a field set. Empty values remove the property. */
export function writeField(item, field, value) {
  const next = structuredClone(item);
  let stored = value;
  if (INVERTED.has(field.name)) {
    stored = value ? false : undefined;
  } else if (field.component === 'boolean') {
    // Unchecking stores false only when the model defaults to true.
    if (value) stored = true;
    else stored = field.value === true ? false : undefined;
  } else if (stored === '' || stored === null || (Array.isArray(stored) && !stored.length)) {
    stored = undefined;
  }
  setPath(next, pathOf(field.name), stored);
  return next;
}

/** Fields grouped into tabs at the model's `tab` fields. */
export function tabsOf(fields) {
  const tabs = [];
  fields.forEach((field) => {
    if (field?.component === 'tab') {
      tabs.push({ label: field.label || field.name, fields: [] });
      return;
    }
    if (!tabs.length) tabs.push({ label: 'Basic', fields: [] });
    tabs.at(-1).fields.push(field);
  });
  return tabs.filter((tab) => tab.fields.length);
}

/** Evaluate a field's json-logic `condition` against the item. */
export function isShown(field, item, fields) {
  if (!field.condition) return true;
  const byName = new Map(fields.filter((f) => f?.name).map((f) => [f.name, f]));
  const evaluate = (node) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return node;
    const [[op, args]] = Object.entries(node);
    const list = [args].flat();
    switch (op) {
      case 'var': return readField(item, byName.get(list[0]) ?? { name: list[0] });
      case '===': case '==': return evaluate(list[0]) === evaluate(list[1]);
      case '!==': case '!=': return evaluate(list[0]) !== evaluate(list[1]);
      case 'and': return list.every((n) => evaluate(n));
      case 'or': return list.some((n) => evaluate(n));
      case '!': return !evaluate(list[0]);
      default: return true;
    }
  };
  return !!evaluate(field.condition);
}

/** An error message for a field value, or null. */
export function validateField(field, value) {
  const empty = value === undefined || value === null || value === ''
    || (Array.isArray(value) && !value.length);
  if (field.required && empty) return `${field.label || field.name} is required.`;
  const regExp = field.validation?.regExp;
  if (regExp && !empty && !new RegExp(regExp).test(String(value))) {
    return field.validation.customErrorMsg || 'The value is not valid.';
  }
  return null;
}

/** A new item for a component, from its template, with a name not used in `model`. */
export function newItem(component, model) {
  let item = { fieldType: component.template?.fieldType ?? 'text-input' };
  const fields = new Map(component.fields.filter((f) => f?.name).map((f) => [f.name, f]));
  Object.entries(component.template ?? {}).forEach(([key, value]) => {
    if (key === 'fieldType') return;
    const field = fields.get(key) ?? { name: key };
    item = writeField(item, field, value);
  });
  if (item.fieldType === 'panel') item.items ??= [];
  item.name = uniqueName(component.id.replace(/^form-/, '').replace(/-(\w)/g, (m, c) => c.toUpperCase()), usedNames(model));
  return item;
}

/** What the outline shows for an item: `{ type, label }`. */
export function describeItem(item, components) {
  const component = componentFor(item, components);
  return {
    type: component?.title ?? item?.fieldType ?? 'Item',
    label: plainText(item?.label?.value) || plainText(item?.value) || item?.name || '',
  };
}
