// Form operator hooks: chat context (setChatContext) and edit (Layout pencil).
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

test('sets the selected field as chat context and clears it', () => {
  const chat = [];
  let report;
  const instance = operator.create(ctx({
    surface: undefined,
    setChatContext: (item) => { chat.push(item); return true; },
    onEditorSelect: (cb) => { report = cb; return () => {}; },
  }));
  report('email');
  report('email');
  assert.equal(chat.length, 1);
  assert.equal(chat[0].label, 'form: Email');
  assert.match(chat[0].innerText, /type email, name email, required/);
  assert.ok(chat[0].innerText.includes(JSON.stringify(model.items[0])));
  report(null);
  assert.deepEqual(chat.slice(1), [null]);
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

test('outline renders directly into the container, without a shadow root', () => {
  const container = document.createElement('div');
  document.body.append(container);
  const instance = operator.create(ctx({ surface: undefined }));
  const handle = instance.outline.mount(container);
  const mount = container.querySelector(':scope > .block-operator');
  assert.ok(mount);
  assert.equal(mount.shadowRoot, null);
  assert.ok(mount.querySelector('[data-id="email"]'));
  handle.unmount();
  assert.equal(container.children.length, 0);
  instance.destroy();
});
