// Form Editor (tools/form-editor): form JSON in the live document, item edits and the
// component models. Run: npm test
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

let fm;
let cm;
let components;

const definition = {
  title: 'Event registration',
  items: [
    { name: 'name', fieldType: 'text-input', label: { value: 'Name' } },
    {
      name: 'attendee',
      fieldType: 'panel',
      label: { value: 'Attendee' },
      items: [
        { id: 'email', name: 'email', fieldType: 'email', label: { value: 'Email' } },
        { name: 'session', fieldType: 'drop-down', label: { value: 'Session' } },
      ],
    },
    { name: 'submit', fieldType: 'button', buttonType: 'submit', label: { value: 'Submit' } },
  ],
};

// A live document as DA sends it: instrumented, with a metadata block DA doesn't count.
const docHtml = (json) => `<body><main><div>
  <div class="metadata"><div><div>Title</div><div>Test</div></div></div>
  <p data-prose-index="3">Intro</p>
  <div class="accordion" data-block-index="20"><div><div>Q</div><div>A</div></div></div>
  <div class="form wide" data-block-index="40"><div><div><pre data-prose-index="41"><code>${json
  .replace(/&/g, '&amp;').replace(/</g, '&lt;')}</code></pre></div></div></div>
</div></main></body>`;

before(async () => {
  const dom = new JSDOM('<!doctype html><body></body>');
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
  globalThis.DOMParser = dom.window.DOMParser;
  // The component models come from this repository.
  globalThis.fetch = async (url) => {
    try {
      const text = await readFile(fileURLToPath(url), 'utf8');
      return { ok: true, status: 200, json: async () => JSON.parse(text) };
    } catch {
      return { ok: false, status: 404 };
    }
  };
  fm = await import('../tools/form-editor/form-model.js');
  cm = await import('../tools/form-editor/components.js');
  components = await cm.loadComponents();
});

test('reads the form block DA points at, and writes it back clean and indented', () => {
  const json = JSON.stringify(definition, null, 2);
  assert.equal(fm.readFormBlock(docHtml(json), 0), null, 'the accordion is block 0');
  const form = fm.readFormBlock(docHtml(json), 1);
  assert.deepEqual(form.model, definition);

  form.model.items[0].label.value = 'Full <b>name</b> & more';
  const html = fm.blockHtml(form, form.model);
  assert.doesNotMatch(html, /data-/, 'no DA instrumentation');
  assert.match(html, /^<div class="form wide"><div><div><pre><code>\{\n {2}"title"/);
  const back = fm.readFormBlock(docHtml(new DOMParser()
    .parseFromString(html, 'text/html').querySelector('code').textContent), 1);
  assert.equal(back.model.items[0].label.value, 'Full <b>name</b> & more');

  const bad = fm.readFormBlock(docHtml('{ not json'), 1);
  assert.match(bad.error, /not valid JSON/);
});

test('moves items within and across containers, never into themselves', () => {
  const model = structuredClone(definition);
  // Last item to the front.
  assert.deepEqual(fm.moveItem(model, [2], [], 0), [0]);
  assert.deepEqual(model.items.map((i) => i.name), ['submit', 'name', 'attendee']);
  // Down by one (index is "before the item now at", so +2).
  assert.deepEqual(fm.moveItem(model, [0], [], 2), [1]);
  assert.deepEqual(model.items.map((i) => i.name), ['name', 'submit', 'attendee']);
  // Into the panel (which sits after the moved item, so its path shifts).
  assert.deepEqual(fm.moveItem(model, [1], [2], 0), [1, 0]);
  assert.deepEqual(model.items[1].items.map((i) => i.name), ['submit', 'email', 'session']);
  // Out of the panel.
  assert.deepEqual(fm.moveItem(model, [1, 2], [], 0), [0]);
  assert.equal(model.items[0].name, 'session');
  // A panel can't go into itself.
  assert.equal(fm.moveItem(model, [2], [2], 0), null);
});

test('duplicates with unique names and ids, deep', () => {
  const model = structuredClone(definition);
  const path = fm.duplicateItem(model, [1]);
  assert.deepEqual(path, [2]);
  const copy = model.items[2];
  assert.equal(copy.name, 'attendee1');
  assert.deepEqual(copy.items.map((i) => [i.id, i.name]), [['email1', 'email1'], [undefined, 'session1']]);
  assert.equal(fm.usedNames(model).size, 8);
});

test('loads every component model with its tabs', () => {
  const ids = components.map((c) => c.id);
  ['text-input', 'multiline-input', 'drop-down', 'panel', 'form-submit-button'].forEach((id) => {
    assert.ok(ids.includes(id), id);
  });
  const textInput = components.find((c) => c.id === 'text-input');
  assert.equal(textInput.title, 'Text Input');
  assert.deepEqual(cm.tabsOf(textInput.fields).map((t) => t.label), ['Basic', 'Validation', 'Help Content']);
  const basic = cm.tabsOf(textInput.fields)[0].fields.map((f) => f.name);
  ['name', 'jcr:title', 'dataRef', 'hideTitle', 'visible', 'enabled', 'readOnly', 'colspan',
    'placeholder', 'default', 'multiLine'].forEach((name) => assert.ok(basic.includes(name), name));
  assert.ok(!components.find((c) => c.id === 'form-fragment').insertable);
  assert.ok(!components.find((c) => c.id === 'multiline-input').insertable, 'no definition');
});

test('maps items to components and fields to AF JSON', () => {
  const byType = (item) => cm.componentFor(item, components).id;
  assert.equal(byType({ fieldType: 'text' }), 'text-input');
  assert.equal(byType({ fieldType: 'select' }), 'drop-down');
  assert.equal(byType({ fieldType: 'tel' }), 'telephone-input');
  assert.equal(byType({ fieldType: 'button', buttonType: 'submit' }), 'form-submit-button');
  assert.equal(byType({ fieldType: 'something-new' }), 'text-input');

  const fields = new Map(components.find((c) => c.id === 'text-input').fields
    .filter((f) => f.name).map((f) => [f.name, f]));
  let item = { name: 'n', fieldType: 'text-input', label: { value: 'Name' } };
  item = cm.writeField(item, fields.get('jcr:title'), 'Full name');
  item = cm.writeField(item, fields.get('hideTitle'), true);
  item = cm.writeField(item, fields.get('colspan'), '6');
  item = cm.writeField(item, fields.get('mandatoryMessage'), 'Needed');
  item = cm.writeField(item, fields.get('visible'), false);
  assert.deepEqual(item, {
    name: 'n',
    fieldType: 'text-input',
    label: { value: 'Full name', visible: false },
    properties: { colspan: '6' },
    constraintMessages: { required: 'Needed' },
    visible: false,
  });
  assert.equal(cm.readField(item, fields.get('hideTitle')), true);
  assert.equal(cm.readField({}, fields.get('enabled')), true, 'model default');
  item = cm.writeField(item, fields.get('mandatoryMessage'), '');
  assert.equal(item.constraintMessages, undefined, 'empty containers are dropped');
  assert.match(cm.validateField(fields.get('name'), '$x'), /\$/);
});

test('new items follow the component template and get a unique name', () => {
  const model = structuredClone(definition);
  const byId = (id) => components.find((c) => c.id === id);
  assert.deepEqual(cm.newItem(byId('text-input'), model), {
    fieldType: 'text-input', label: { value: 'Text Input' }, name: 'textInput',
  });
  const panel = cm.newItem(byId('panel'), model);
  assert.deepEqual(panel.items, []);
  assert.equal(panel.minOccur, 1);
  const checkbox = cm.newItem(byId('checkbox'), model);
  assert.deepEqual(checkbox.enum, ['on']);
  const radios = cm.newItem(byId('radio-group'), model);
  assert.equal(radios.properties['afs:layout'].orientation, 'horizontal');
  const submit = cm.newItem(byId('form-submit-button'), model);
  assert.equal(submit.buttonType, 'submit');
  model.items.push(cm.newItem(byId('text-input'), model));
  assert.equal(cm.newItem(byId('text-input'), model).name, 'textInput1');
});

test('panel fields follow their conditions', () => {
  const panel = components.find((c) => c.id === 'panel');
  const minOccur = panel.fields.find((f) => f.name === 'minOccur');
  assert.equal(cm.isShown(minOccur, { fieldType: 'panel' }, panel.fields), false);
  assert.equal(cm.isShown(minOccur, { fieldType: 'panel', repeatable: true }, panel.fields), true);
});
