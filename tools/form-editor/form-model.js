/*
 * Form Editor: the form block in DA's live document, and edits to its form JSON.
 * Items are addressed by path: indexes through `items`, e.g. [3, 0] is items[3].items[0].
 */

const NON_BLOCKS = new Set(['metadata', 'section-metadata']);

/** The document's blocks in DA's order (`selection.blockIndex` counts the same way). */
export function documentBlocks(doc) {
  return [...doc.querySelectorAll('main > div > div[class]')]
    .filter((el) => !NON_BLOCKS.has(el.classList[0]));
}

function parseJson(text) {
  const value = JSON.parse(text);
  // Some sources store the definition as a JSON string of JSON.
  if (typeof value === 'string') return { model: JSON.parse(value), encoded: true };
  return { model: value, encoded: false };
}

/**
 * The form block at `blockIndex` of a live document's HTML: `{ block, model, text, encoded }`,
 * `{ block, error }` when its JSON can't be read, or null when that block isn't a form block.
 */
export function readFormBlock(docHtml, blockIndex, parser = new DOMParser()) {
  if (typeof docHtml !== 'string' || !Number.isInteger(blockIndex)) return null;
  const doc = parser.parseFromString(docHtml, 'text/html');
  const block = documentBlocks(doc)[blockIndex];
  if (!block || block.classList[0] !== 'form') return null;
  const code = block.querySelector('pre code') ?? block.querySelector('pre');
  if (!code) return { block, error: 'The form block has no form definition (code block).' };
  const text = code.textContent;
  try {
    const { model, encoded } = parseJson(text);
    if (!model || typeof model !== 'object' || Array.isArray(model)) {
      throw new Error('not an object');
    }
    if (!Array.isArray(model.items)) model.items = [];
    return {
      block, model, text, encoded,
    };
  } catch (error) {
    return { block, error: `The form definition is not valid JSON (${error.message}).` };
  }
}

/** JSON text for `model`, indented like `previous` (on one line when it was on one line). */
export function serializeModel(model, previous = '', encoded = false) {
  const multiline = previous.includes('\n');
  const indent = previous.match(/\n([ \t]+)"/)?.[1] ?? 2;
  const json = JSON.stringify(model, null, multiline ? indent : undefined);
  return encoded ? JSON.stringify(json) : json;
}

/** The block's HTML with `model` as its form definition, without DA's instrumentation. */
export function blockHtml(form, model) {
  const block = form.block.cloneNode(true);
  [block, ...block.querySelectorAll('*')].forEach((el) => {
    [...el.attributes].filter((attr) => attr.name.startsWith('data-'))
      .forEach((attr) => el.removeAttribute(attr.name));
  });
  const code = block.querySelector('pre code') ?? block.querySelector('pre');
  code.textContent = serializeModel(model, form.text, form.encoded);
  return block.outerHTML;
}

/* ---------- Items ---------- */

export const isContainer = (item) => item?.fieldType === 'panel' || Array.isArray(item?.items);

/** The item at `path`, or undefined. The empty path is the form itself. */
export function itemAt(model, path) {
  return path.reduce((node, index) => node?.items?.[index], model);
}

function listAt(model, parentPath) {
  const parent = itemAt(model, parentPath);
  if (!parent) return null;
  if (!Array.isArray(parent.items)) parent.items = [];
  return parent.items;
}

export const samePath = (a, b) => Array.isArray(a) && Array.isArray(b)
  && a.length === b.length && a.every((v, i) => v === b[i]);

/** Whether `path` is `ancestor` or inside it. */
export const isWithin = (path, ancestor) => ancestor.length <= path.length
  && ancestor.every((v, i) => v === path[i]);

/** Remove the item at `path`. Returns the removed item. */
export function removeItem(model, path) {
  const [removed] = listAt(model, path.slice(0, -1)).splice(path.at(-1), 1);
  return removed;
}

/** Insert `item` in the container at `parentPath` at `index` (default: last). Returns its path. */
export function insertItem(model, parentPath, item, index) {
  const list = listAt(model, parentPath);
  const at = index === undefined ? list.length : Math.max(0, Math.min(index, list.length));
  list.splice(at, 0, item);
  return [...parentPath, at];
}

/**
 * Move the item at `from` into the container at `parentPath`, before the item at `index` there
 * (both as they are before the move). Returns the new path, or null for a move into itself.
 */
export function moveItem(model, from, parentPath, index) {
  if (isWithin(parentPath, from)) return null;
  const parent = [...parentPath];
  let at = index;
  const depth = from.length - 1;
  // Removing the item shifts its later siblings, and containers among them, up by one.
  if (parent.length > depth && samePath(parent.slice(0, depth), from.slice(0, -1))
    && parent[depth] > from[depth]) parent[depth] -= 1;
  if (samePath(parent, from.slice(0, -1)) && at > from[depth]) at -= 1;
  const item = removeItem(model, from);
  return insertItem(model, parent, item, at);
}

/** Every name and id used in the form. */
export function usedNames(model) {
  const names = new Set();
  const walk = (items) => (items || []).forEach((item) => {
    if (item?.name) names.add(item.name);
    if (item?.id) names.add(item.id);
    walk(item?.items);
  });
  walk(model.items);
  return names;
}

/** `base`, else `base1`, `base2`, …: the first one not in `taken` (and adds it there). */
export function uniqueName(base, taken) {
  const root = String(base || 'field').replace(/[^A-Za-z0-9_]+/g, '').replace(/\d+$/, '') || 'field';
  let name = root;
  for (let n = 1; taken.has(name); n += 1) name = `${root}${n}`;
  taken.add(name);
  return name;
}

/** Insert a copy of the item at `path` after it, with new names and ids. Returns its path. */
export function duplicateItem(model, path) {
  const taken = usedNames(model);
  const copy = structuredClone(itemAt(model, path));
  const rename = (item) => {
    const { id, name } = item;
    if (name) item.name = uniqueName(name, taken);
    // An id equal to the name stays equal to it.
    if (id) item.id = id === name ? item.name : uniqueName(id, taken);
    (item.items || []).forEach(rename);
  };
  rename(copy);
  return insertItem(model, path.slice(0, -1), copy, path.at(-1) + 1);
}

/** Plain text of a label (labels may hold rich text). */
export function plainText(value) {
  return String(value ?? '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
