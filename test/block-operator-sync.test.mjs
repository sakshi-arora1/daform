// Selection sync between the block operator outline (da.live page), the Block Inspector and the
// Layout view: messages must settle instead of echoing back and forth.
// Run: npm test
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const DA = 'https://da.live/canvas#/sakshi-arora1/daform/test';
const SITE = 'https://main--daform--sakshi-arora1.preview.da.live';
const SCOPE = { org: 'sakshi-arora1', site: 'daform' };

let sync;
let sharedState;
let frames;

const select = (itemId, extra = {}) => ({
  type: 'block-operator-select', ...SCOPE, blockIndex: 0, block: 'form', itemId, ...extra,
});

// An iframe on the site's origin whose window records what it receives and can answer.
function addFrame(name, onMessage = () => {}) {
  const { window } = globalThis;
  const frame = window.document.createElement('iframe');
  frame.setAttribute('src', `${SITE}/${name}`);
  window.document.body.append(frame);
  const received = [];
  const win = {
    postMessage(data) {
      received.push(data);
      onMessage(data, win);
    },
  };
  Object.defineProperty(frame, 'contentWindow', { value: win });
  frames[name] = { frame, win, received };
  return frames[name];
}

// What a frame sends to the da.live page.
function fromFrame(name, data) {
  const { window } = globalThis;
  window.dispatchEvent(new window.MessageEvent('message', {
    origin: SITE, source: frames[name].win, data,
  }));
}

before(async () => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: DA });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
  sync = await import('../scripts/block-operator-sync.js');
  sharedState = await import('../tools/block-operators/shared.js');
});

function freshPage() {
  globalThis.document.body.replaceChildren();
  frames = {};
  // Reset the page-wide registry between tests (same object every module copy uses).
  const registry = globalThis.window[Symbol.for('block-operators.outline-sync')];
  registry.instances.clear();
  registry.latest = null;
  registry.allow = () => true;
}

// An operator instance in the da.live page, backed by a fake editor whose `resolve` maps the
// caret to `caretItem(itemId)` (a different item when the caret lands elsewhere).
function outlineInstance({ caretItem = (id) => id } = {}) {
  const editor = { listeners: new Set(), selects: [] };
  const ctx = {
    name: 'form',
    blockIndex: 0,
    html: '<div class="form"></div>',
    select(itemId) {
      editor.selects.push(itemId);
      // The editor reports the caret synchronously, like DA does after a dispatch.
      editor.listeners.forEach((cb) => cb(caretItem(itemId)));
      return true;
    },
    onEditorSelect(cb) {
      editor.listeners.add(cb);
      return () => editor.listeners.delete(cb);
    },
  };
  const state = sharedState.createState(ctx, { hasItem: () => true });
  return { state, editor };
}

test('an echoing frame does not start a loop', () => {
  freshPage();
  const { state } = outlineInstance();
  // A frame that answers every selection with a fresh copy, as a misbehaving surface might.
  let echoes = 0;
  addFrame('echo', (data, win) => {
    if (data.type !== 'block-operator-select' || echoes > 100) return;
    echoes += 1;
    window.dispatchEvent(new window.MessageEvent('message', {
      origin: SITE, source: win, data: { ...data, source: 'preview' },
    }));
  });
  addFrame('inspector');

  state.select('email');
  assert.equal(echoes, 1, 'the echo of a known selection is not relayed or applied again');
  assert.deepEqual(frames.inspector.received.map((m) => m.itemId), ['email']);
});

test('a received selection is applied but never re-published', () => {
  freshPage();
  // The caret lands on another item (e.g. resolve/locate disagree): that must not be sent on.
  const { state, editor } = outlineInstance({ caretItem: () => 'drivingLicense' });
  addFrame('inspector');
  addFrame('layout');

  fromFrame('layout', select('phone', { source: 'preview' }));
  assert.equal(state.selectedId, 'phone');
  assert.deepEqual(editor.selects, ['phone']);
  assert.deepEqual(frames.inspector.received.map((m) => m.itemId), ['phone'], 'relayed once');
  assert.deepEqual(frames.layout.received, [], 'not sent back to its sender');

  // A tree click whose caret resolves elsewhere keeps the clicked item too.
  state.select('email');
  assert.equal(state.selectedId, 'email');
  assert.deepEqual(frames.inspector.received.map((m) => m.itemId), ['phone', 'email']);
});

test('get-selection returns the latest selection, once, across module copies', async () => {
  freshPage();
  const copy = await import('../scripts/block-operator-sync.js?copy=2');
  const { unregister } = copy.registerOutline({
    block: () => 'form', blockIndex: () => 0, hasItem: () => true, onSelect() {},
  });
  const { state } = outlineInstance();
  addFrame('inspector');
  state.select('phone');

  frames.inspector.received.length = 0;
  fromFrame('inspector', { type: 'block-operator-get-selection' });
  assert.deepEqual(frames.inspector.received.map((m) => m.itemId), ['phone']);
  unregister();
});

test('a runaway exchange is cut off', () => {
  freshPage();
  let t = 0;
  const allow = sync.rateLimiter(5, () => t);
  window[Symbol.for('block-operators.outline-sync')].allow = allow;
  outlineInstance();
  addFrame('layout');
  addFrame('inspector');
  // Every message is a new item, so dedupe doesn't stop it; the rate limit does.
  for (let i = 0; i < 50; i += 1) fromFrame('layout', select(`item${i}`));
  assert.equal(frames.inspector.received.length, 5);
  t = 1000;
  fromFrame('layout', select('later'));
  assert.equal(frames.inspector.received.at(-1).itemId, 'later', 'resumes after a second');
});

test('frames apply the same selection once (channel and relay)', () => {
  const applied = [];
  const connection = sync.connectFrame({
    scope: () => SCOPE,
    onSelect: (m) => applied.push(m.itemId),
  });
  const channel = new BroadcastChannel(sync.CHANNEL_NAME);
  channel.postMessage(select('email', { source: 'inspector' }));
  return new Promise((resolve) => {
    setTimeout(() => {
      channel.postMessage(select('email', { source: 'outline' }));
      setTimeout(() => {
        assert.deepEqual(applied, ['email']);
        channel.close();
        connection.close();
        resolve();
      }, 20);
    }, 20);
  });
});
