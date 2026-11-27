// Form operator hooks: describe (chat context) and edit (Layout pencil).
// Run: npm test
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

let operator;
let INSPECTOR_PANEL;

const model = { items: [{ id: 'email', name: 'email', fieldType: 'email', required: true, label: { value: 'Email' } }] };
const html = `<div class="form"><div><div><pre><code>${JSON.stringify(model)}</code></pre></div></div></div>`;
const ctx = (extra = {}) => ({
  name: 'form', variant: '', blockIndex: 0, html, editable: true, styles: [], surface: 'inspector',
  commit: async () => ({ ok: true }), select: () => ({ ok: true }), onEditorSelect: () => () => {}, ...extra,
});

before(async () => {
  const { window } = new JSDOM('<!doctype html><body></body>', { url: 'https://main--site--org.preview.da.live/' });
  Object.assign(globalThis, {
    window, document: window.document, Node: window.Node, CSSStyleSheet: window.CSSStyleSheet ?? class {},
  });
  ({ default: operator, INSPECTOR_PANEL } = await import('../tools/block-operators/form.js'));
});

test('describe returns the field label, summary and JSON', () => {
  const instance = operator.create(ctx());
  const described = instance.describe('email');
  assert.equal(described.label, 'Email');
  assert.match(described.text, /type email, name email, required/);
  assert.deepEqual(described.data, model.items[0]);
  assert.equal(instance.describe('missing'), null);
  instance.destroy();
});

test('edit opens the Block Inspector, and falls back without openPanel', () => {
  const opened = [];
  const withPanel = operator.create(ctx({ openPanel: (name) => { opened.push(name); return true; } }));
  assert.equal(withPanel.edit(), true);
  assert.deepEqual(opened, [INSPECTOR_PANEL]);
  assert.equal(operator.create(ctx()).edit(), false);
  assert.equal(operator.create(ctx({ openPanel: () => false })).edit(), false);
});
