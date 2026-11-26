/*
 * Selection sync for block operators, without platform support. Three surfaces show the same
 * selection:
 * - the outline: the block operator running in the da.live page (hosted by da-live);
 * - the Block Inspector: tools/block-editor, an iframe on the site's preview.da.live origin;
 * - the Layout view: the site's page in an iframe (`?quick-edit`), e.g. blocks/form.
 * Message: { type: SELECT_MESSAGE, org, site, path?, blockIndex, block, itemId, source }.
 * The da.live page talks to the iframes with postMessage (origins checked on both sides); the
 * iframes on the same site origin also share BroadcastChannel(CHANNEL_NAME). The outline relays
 * what one iframe sends to the others, so they stay in sync even on different origins.
 */
export const SELECT_MESSAGE = 'block-operator-select';
export const GET_SELECTION_MESSAGE = 'block-operator-get-selection';
export const CHANNEL_NAME = 'block-operators';

const DEV_HOST = /^(?:localhost|127\.0\.0\.1)$/;
const SITE_HOST = /^[a-z0-9-]+--([a-z0-9-]+)--([a-z0-9-]+)\.(?:preview\.da\.live|aem\.page|aem\.live)$/;
const DA_HOST = /^(?:da\.live|[a-z0-9-]+--da-live--[a-z0-9-]+\.aem\.(?:page|live))$/;

function toUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

const lower = (value) => String(value ?? '').toLowerCase();

export const isDevOrigin = (origin) => DEV_HOST.test(toUrl(origin)?.hostname ?? '');

export function sameSite(a, b) {
  return lower(a?.org) === lower(b?.org) && lower(a?.site) === lower(b?.site);
}

/** `{ org, site }` of a site origin (`https://{ref}--{site}--{org}.preview.da.live`, aem.page, aem.live). */
export function siteOf(origin) {
  const url = toUrl(origin);
  const match = url?.protocol === 'https:' && url.hostname.match(SITE_HOST);
  return match ? { org: match[2], site: match[1] } : null;
}

/** Whether `origin` serves the site; local dev servers count when the page itself is local. */
export function isSiteOrigin(origin, scope, pageOrigin = window.location.origin) {
  const site = siteOf(origin);
  if (site) return sameSite(site, scope);
  return isDevOrigin(origin) && isDevOrigin(pageOrigin);
}

/** Whether `origin` is DA: da.live, a da-live branch, or a local dev server. */
export function isDaOrigin(origin) {
  const url = toUrl(origin);
  if (!url) return false;
  if (DEV_HOST.test(url.hostname)) return true;
  return url.protocol === 'https:' && DA_HOST.test(url.hostname);
}

/** A select message for `scope` (`{ org, site }`; unknown on a local server: accept any). */
export function isSelectMessage(data, scope) {
  if (data?.type !== SELECT_MESSAGE || typeof data.block !== 'string') return false;
  if (data.itemId != null && typeof data.itemId !== 'string') return false;
  if (!Number.isInteger(data.blockIndex)) return false;
  return !scope?.org || !scope?.site || sameSite(data, scope);
}

export const normalizeBlock = (name) => lower(name).replace(/[\s_-]+/g, ' ').trim();

/** Whether two select messages select the same item (the source doesn't matter). */
export function sameSelection(a, b) {
  return !!a && !!b && normalizeBlock(a.block) === normalizeBlock(b.block)
    && a.blockIndex === b.blockIndex && (a.itemId ?? null) === (b.itemId ?? null)
    && lower(a.org) === lower(b.org) && lower(a.site) === lower(b.site);
}

// A runaway exchange (e.g. two senders echoing each other) is cut off after this many messages
// per second.
export const MAX_MESSAGES_PER_SECOND = 30;

export function rateLimiter(limit = MAX_MESSAGES_PER_SECOND, now = () => Date.now()) {
  let start = 0;
  let count = 0;
  let warned = false;
  return () => {
    const t = now();
    if (t - start >= 1000) {
      start = t;
      count = 0;
    }
    count += 1;
    if (count <= limit) return true;
    if (!warned) {
      warned = true;
      // eslint-disable-next-line no-console
      console.warn('[block-operators] too many selection messages; dropping some');
    }
    return false;
  };
}

/**
 * Stable ids for the items of a form model: the item's `id`, else its `name`, else its JSON
 * pointer (`/items/17/items/0`). An id already taken falls back to the pointer. Returns
 * `{ idOf: Map<pointer, id>, pointerOf: Map<id, pointer> }`.
 */
export function formItemIds(model) {
  const idOf = new Map();
  const pointerOf = new Map();
  const walk = (items, base) => (Array.isArray(items) ? items : []).forEach((item, index) => {
    const pointer = `${base}/items/${index}`;
    let id = [item?.id, item?.name].find((value) => typeof value === 'string' && value) ?? pointer;
    if (pointerOf.has(id)) id = pointer;
    idOf.set(pointer, id);
    pointerOf.set(id, pointer);
    walk(item?.items, pointer);
  });
  walk(model?.items, '');
  return { idOf, pointerOf };
}

/** Every iframe in `root`, including inside open shadow roots. */
export function findFrames(root = document) {
  const frames = [];
  const walk = (node) => node.querySelectorAll('*').forEach((el) => {
    if (el.tagName === 'IFRAME') frames.push(el);
    if (el.shadowRoot) walk(el.shadowRoot);
  });
  walk(root);
  return frames;
}

function frameOrigin(frame) {
  const src = frame.getAttribute('src');
  return src ? toUrl(new URL(src, window.location.href).href)?.origin ?? null : null;
}

/** `{ org, site, path }` of the da.live page (`#/org/site/path…`). */
export function daPageScope(location = window.location) {
  const [, org, site, ...path] = location.hash.replace(/^#/, '').split('/');
  return org && site ? { org, site, path: path.length ? `/${path.join('/')}` : undefined } : null;
}

/* ---------- Outline side: the operator instances in the da.live page ---------- */

// One registry per page, shared by every copy of this module (an operator can be loaded from
// two URLs, e.g. a branch and main): one listener, one relay, one latest selection.
const outline = (() => {
  const key = Symbol.for('block-operators.outline-sync');
  window[key] ??= {
    instances: new Set(),
    latest: null,
    listening: false,
    allow: rateLimiter(),
  };
  return window[key];
})();

function postToFrames(message, except) {
  const scope = daPageScope();
  if (!scope) return;
  findFrames().forEach((frame) => {
    const origin = frameOrigin(frame);
    const target = frame.contentWindow;
    if (!origin || !target || target === except || !isSiteOrigin(origin, scope)) return;
    try {
      target.postMessage(message, origin);
    } catch { /* the frame navigated away */ }
  });
}

// Instances whose block the message targets: the same block index, else any that has the item
// (the Layout page can't count blocks exactly as DA does; auto-blocks shift its count).
function targets(message) {
  const named = [...outline.instances]
    .filter((entry) => normalizeBlock(entry.block()) === normalizeBlock(message.block));
  const exact = named.filter((entry) => entry.blockIndex() === message.blockIndex);
  if (exact.length) return exact;
  return message.itemId == null ? [] : named.filter((entry) => entry.hasItem(message.itemId));
}

function onOutlineMessage(event) {
  const scope = daPageScope();
  if (!scope || !isSiteOrigin(event.origin, scope)) return;
  const { data } = event;
  if (data?.type === GET_SELECTION_MESSAGE) {
    if (outline.latest) event.source?.postMessage(outline.latest, event.origin);
    return;
  }
  // Known selections are neither applied nor relayed again; that ends any echo.
  if (!isSelectMessage(data, scope) || sameSelection(data, outline.latest)) return;
  if (!outline.allow()) return;
  outline.latest = data;
  targets(data).forEach((entry) => entry.onSelect(data.itemId ?? null));
  postToFrames(data, event.source);
}

/**
 * Register an operator instance in the da.live page. `entry`: `{ block(), blockIndex(),
 * hasItem(itemId), onSelect(itemId) }`. Returns `{ publish(itemId), unregister() }`.
 */
export function registerOutline(entry) {
  if (!outline.listening) {
    window.addEventListener('message', onOutlineMessage);
    outline.listening = true;
  }
  outline.instances.add(entry);
  return {
    publish(itemId) {
      const scope = daPageScope();
      if (!scope) return;
      const message = {
        type: SELECT_MESSAGE,
        ...scope,
        blockIndex: entry.blockIndex(),
        block: entry.block(),
        itemId: itemId ?? null,
        source: 'outline',
      };
      if (sameSelection(message, outline.latest) || !outline.allow()) return;
      outline.latest = message;
      postToFrames(message);
    },
    unregister() {
      outline.instances.delete(entry);
    },
  };
}

/* ---------- Iframe side: the Block Inspector and the Layout page ---------- */

/** The da.live origin this iframe is embedded in, or null. */
export function parentOrigin() {
  if (window.parent === window) return null;
  const candidates = [
    window.location.ancestorOrigins?.[0],
    document.referrer && toUrl(document.referrer)?.origin,
  ];
  return candidates.find((origin) => origin && isDaOrigin(origin)) ?? null;
}

/**
 * Join the sync from an iframe. `onSelect(message)` gets select messages for `scope` from the
 * parent (DA) or the channel. Returns `{ publish(message), requestSelection(), close() }`.
 */
export function connectFrame({ scope, onSelect }) {
  const parent = parentOrigin();
  const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(CHANNEL_NAME) : null;
  const allow = rateLimiter();
  let last = null;
  // The same selection arrives twice (channel and relay): apply it once.
  const accept = (data) => {
    if (!isSelectMessage(data, scope()) || sameSelection(data, last) || !allow()) return;
    last = data;
    onSelect(data);
  };
  const onMessage = (event) => {
    if (event.source !== window.parent || !isDaOrigin(event.origin)) return;
    accept(event.data);
  };
  const onChannel = (event) => accept(event.data);
  window.addEventListener('message', onMessage);
  channel?.addEventListener('message', onChannel);
  return {
    publish(message) {
      const full = { type: SELECT_MESSAGE, ...scope(), ...message };
      if (sameSelection(full, last) || !allow()) return;
      last = full;
      channel?.postMessage(full);
      if (parent) window.parent.postMessage(full, parent);
    },
    requestSelection() {
      if (parent) window.parent.postMessage({ type: GET_SELECTION_MESSAGE }, parent);
    },
    close() {
      window.removeEventListener('message', onMessage);
      channel?.removeEventListener('message', onChannel);
      channel?.close();
    },
  };
}
