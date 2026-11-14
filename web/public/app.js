(() => {
  'use strict';
  const BOOT = JSON.parse(document.getElementById('boot').textContent || '{}');
  const API = (BOOT.apiBase || '') + '/api/v1';
  const app = document.getElementById('app');
  const NS = 'http://www.w3.org/2000/svg';

  // ── tiny DOM helpers (text is always set via textContent → no HTML injection) ──
  function h(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'style') n.style.cssText = v; // CSSOM (CSP-safe), not an inline style attribute
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat()) if (c != null && c !== false) n.append(c.nodeType ? c : document.createTextNode(String(c)));
    return n;
  }
  function ic(name) {
    const s = document.createElementNS(NS, 'svg');
    s.setAttribute('class', 'ic'); s.setAttribute('aria-hidden', 'true');
    const u = document.createElementNS(NS, 'use'); u.setAttribute('href', '#i-' + name);
    s.append(u); return s;
  }
  const ext = (href) => ({ href, target: '_blank', rel: 'noopener noreferrer' });

  // ── persistent anonymous device token (rate-limiting / idempotency only, never identity) ──
  function deviceId() {
    try {
      let d = localStorage.getItem('veylo_did');
      if (!d) {
        const b = crypto.getRandomValues(new Uint8Array(18));
        d = btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        localStorage.setItem('veylo_did', d);
      }
      return d;
    } catch { return null; }
  }
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };

  async function api(path, opts = {}) {
    const headers = { Accept: 'application/json' };
    if (opts.method === 'POST') headers['Content-Type'] = 'application/json';
    const d = deviceId(); if (d) headers['X-Veylo-Device'] = d;
    const res = await fetch(API + path, { ...opts, headers });
    let body = null; try { body = await res.json(); } catch { /* non-JSON */ }
    if (!res.ok) throw Object.assign(new Error('api'), { status: res.status, code: body && body.error });
    return body;
  }

  // ── formatting ──
  const STATUS = { ACTIVE: 'ACTIVE', ALMOST_FULL: 'ALMOST FULL', FULL: 'FULL', EXPIRED: 'EXPIRED', CANCELLED: 'CANCELLED' };
  const pill = (s) => h('span', { class: 'pill pill--' + s, text: STATUS[s] || s });
  function left(ms) {
    if (ms <= 0) return 'Ended';
    const s = Math.floor(ms / 1000), d = Math.floor(s / 86400), hr = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    if (d) return `${d}d ${hr}h`; if (hr) return `${hr}h ${m}m`; return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  }
  const expiryText = (g) => (g.expiresAt ? left(new Date(g.expiresAt) - Date.now()) : 'No expiry');
  const mmss = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const pct = (g) => Math.min(100, Math.round(((g.maxClaimers - g.availableSlots) / Math.max(1, g.maxClaimers)) * 100));

  // ── shared partners (links come ONLY from server configuration) ──
  const botBtn = (label = 'Open VEYLO Bot', cls = 'btn btn--primary') => h('a', { class: cls, ...ext(BOOT.botUrl) }, ic('send'), label);
  const chanBtn = (label = 'Join the Channel', cls = 'btn') => h('a', { class: cls, ...ext(BOOT.channelUrl) }, ic('bell'), label);
  const supBtn = (label = 'Support', cls = 'btn btn--ghost') => (BOOT.supportUrl ? h('a', { class: cls, ...ext(BOOT.supportUrl) }, ic('help'), label) : null);
  const timers = [];
  const clearTimers = () => { while (timers.length) clearInterval(timers.pop()); };

  // ── cards ──
  function giveawayCard(g) {
    return h('a', { class: 'card', href: '/g/' + g.slug, 'data-link': true },
      h('div', { class: 'gw__top' }, pill(g.status), h('span', { class: 'meta', text: expiryText(g) })),
      h('div', { class: 'gw__amt' }, h('b', { text: g.amountPerUser }), h('span', { text: g.asset + ' / participant' })),
      h('h3', { text: g.title }),
      h('div', { class: 'bar', 'aria-hidden': 'true' }, h('i', { style: `width:${pct(g)}%` })),
      h('div', { class: 'meta' }, h('span', { text: `${g.availableSlots} of ${g.maxClaimers} slots left` }), h('span', { text: 'View →' })));
  }
  function emptyState(msg) {
    return h('div', { class: 'empty' }, h('h3', { text: 'No active giveaways right now' }), h('p', { text: msg }),
      h('div', { class: 'links', style: 'justify-content:center' }, chanBtn('Get notified in the channel')));
  }
  async function fillGiveaways(target, { limit, exclude, status } = {}) {
    target.replaceChildren(h('div', { class: 'skel' }), h('div', { class: 'skel' }), h('div', { class: 'skel' }));
    try {
      const { giveaways } = await api(`/giveaways?limit=${limit || 12}${status ? '&status=' + status : ''}`);
      const list = giveaways.filter((g) => g.slug !== exclude);
      target.replaceChildren(...(list.length ? list.map(giveawayCard) : [emptyState('New giveaways are announced in the official channel first.')]));
      if (!list.length) target.classList.remove('grid'); else target.classList.add('grid');
    } catch {
      target.classList.remove('grid');
      target.replaceChildren(h('div', { class: 'empty' }, h('p', { text: "We couldn't load giveaways. Please refresh in a moment." })));
    }
  }

  // ── pages ──
  function homeView() {
    const stats = h('div', { class: 'stats', hidden: true });
    const preview = h('div', { class: 'grid grid--3' });
    const view = h('div', { class: 'view' },
      h('section', { class: 'hero' }, h('div', { class: 'wrap' },
        h('span', { class: 'eyebrow', text: 'Giveaways · Rewards · Telegram' }),
        h('h1', {}, 'Discover Giveaways. Claim Rewards. Experience ', h('span', { class: 'grad', text: 'VEYLO.' })),
        h('p', { class: 'lead', text: 'Your destination for exciting giveaways and seamless reward distribution. Discover opportunities, claim your code, and complete your reward through the Veylo Telegram bot.' }),
        h('div', { class: 'hero__cta' }, h('a', { class: 'btn btn--primary', href: '/giveaways', 'data-link': true }, 'Explore Giveaways', ic('arrow')), botBtn('Open VEYLO Bot', 'btn')),
        stats)),
      h('section', {}, h('div', { class: 'wrap' },
        h('div', { class: 'row-h' }, h('div', { class: 'sec-h' }, h('span', { class: 'eyebrow', text: 'Live now' }), h('h2', { text: 'Active giveaways' })),
          h('a', { class: 'btn btn--sm', href: '/giveaways', 'data-link': true }, 'View all')),
        preview)),
      h('section', { id: 'how' }, h('div', { class: 'wrap' },
        h('div', { class: 'sec-h' }, h('span', { class: 'eyebrow', text: 'How it works' }), h('h2', { text: 'Three steps to your reward' })),
        h('div', { class: 'steps' },
          ...[['Discover an active giveaway', 'Browse live giveaways with real reward amounts and slot counts.'],
              ['Generate and copy your claim code', 'No sign-up. Tap Claim Reward and a secure, single-use code is reserved for you.'],
              ['Redeem it in the VEYLO Telegram bot', 'Paste the code in the bot, confirm your wallet address, and receive your reward.']]
            .map(([t, d]) => h('div', { class: 'card step' }, h('h3', { text: t }), h('p', { class: 'meta', text: d })))),
        h('div', { class: 'note' }, ic('shield'), h('span', { text: 'Rewards are claimed and paid out entirely inside the official VEYLO Telegram bot. The website only gives you a code — it never asks for your wallet, keys or login.' })))),
      h('section', {}, h('div', { class: 'wrap promo' },
        h('div', { class: 'card' }, h('div', { class: 'ico' }, ic('send')), h('h3', { text: 'The VEYLO Telegram bot' }),
          h('p', { text: 'Redeem codes, confirm your wallet address and receive rewards — fast, inside Telegram.' }), botBtn('Open VEYLO Bot')),
        h('div', { class: 'card' }, h('div', { class: 'ico' }, ic('bell')), h('h3', { text: 'Official channel' }),
          h('p', { text: 'Stay connected with Veylo. Get the latest giveaway announcements, exclusive rewards, updates, and new opportunities through our official Telegram channel.' }), chanBtn()))),
      h('section', {}, h('div', { class: 'wrap' }, h('div', { class: 'cta' },
        h('h2', { text: 'Want to create your own giveaway?' }), h('p', { text: 'Launch your giveaway and distribute rewards with Veylo.' }), botBtn('Open VEYLO Bot')))),
      BOOT.supportUrl ? h('section', {}, h('div', { class: 'wrap' }, h('div', { class: 'card', style: 'display:flex;gap:16px;align-items:center;flex-wrap:wrap;justify-content:space-between' },
        h('div', {}, h('h3', { text: 'Need help?' }), h('p', { class: 'meta', text: 'Questions about a code or a reward? Our support team is here.' })), supBtn('Contact Support', 'btn')))) : null);
    document.title = 'VEYLO — Discover Giveaways. Claim Rewards.';
    app.replaceChildren(view);
    fillGiveaways(preview, { limit: 3 });
    api('/stats').then((s) => {
      const cells = [[String(s.activeGiveaways), 'Active giveaways'], [String(s.rewardsDelivered), 'Rewards delivered'],
        [s.distributed.length ? s.distributed.map((d) => `${d.total} ${d.asset}`).join(' · ') : '0', 'Distributed']];
      stats.replaceChildren(...cells.map(([v, l]) => h('div', { class: 'stat' }, h('b', { text: v }), h('span', { text: l }))));
      stats.hidden = false;
    }).catch(() => {});
    return view;
  }

  function listView() {
    const grid = h('div', { class: 'grid grid--3' });
    app.replaceChildren(h('div', { class: 'view' }, h('section', {}, h('div', { class: 'wrap' },
      h('div', { class: 'sec-h' }, h('span', { class: 'eyebrow', text: 'Giveaways' }), h('h2', { text: 'Discover giveaways' }),
        h('p', { text: 'Live data straight from VEYLO. Slot counts and status update as people claim.' })), grid))));
    document.title = 'Giveaways — VEYLO';
    fillGiveaways(grid, { limit: 24, status: 'all' });
  }

  function notFoundView(msg) {
    app.replaceChildren(h('div', { class: 'view' }, h('section', {}, h('div', { class: 'wrap' }, h('div', { class: 'empty' },
      h('h3', { text: msg || 'Page not found' }), h('p', { text: 'The link may be wrong or the giveaway is no longer available.' }),
      h('div', { class: 'links', style: 'justify-content:center' }, h('a', { class: 'btn btn--primary', href: '/giveaways', 'data-link': true }, 'Explore Giveaways'), supBtn())))))); 
    document.title = 'Not found — VEYLO';
  }

  async function copyText(t) {
    try { await navigator.clipboard.writeText(t); return true; } catch { /* fall through */ }
    const ta = h('textarea', { readonly: true, 'aria-hidden': 'true', style: 'position:fixed;opacity:0;top:0' }); ta.value = t;
    document.body.append(ta); ta.select(); ta.setSelectionRange(0, 99);
    let ok = false; try { ok = document.execCommand('copy'); } catch { /* ignore */ }
    ta.remove(); return ok;
  }

  async function detailView(slug) {
    app.replaceChildren(h('div', { class: 'wrap' }, h('div', { class: 'skel', style: 'margin-top:40px;height:320px' })));
    let g;
    try { g = (await api('/giveaways/' + encodeURIComponent(slug))).giveaway; }
    catch (e) { return notFoundView(e.status === 404 ? 'Giveaway not found' : 'Something went wrong'); }
    document.title = `${g.title} — VEYLO`;

    const factVals = {};
    const fact = (key, label, val) => { const b = h('b', { text: val }); factVals[key] = b; return h('div', { class: 'fact' }, h('span', { text: label }), b); };
    const barFill = h('i'); let pillNode = pill(g.status);
    const panel = h('div', { class: 'card panel' });

    const left1 = h('div', { class: 'card panel' },
      h('div', { class: 'gw__top' }, pillNode),
      h('h1', { text: g.title }),
      h('p', { class: 'sub', text: 'Claim a code here, then redeem it in the VEYLO Telegram bot to receive your reward.' }),
      h('div', { class: 'facts' },
        fact('amt', 'Reward per participant', `${g.amountPerUser} ${g.asset}`), fact('pool', 'Total reward pool', `${g.totalAmount} ${g.asset}`),
        fact('avail', 'Available slots', ''), fact('claimed', 'Claimed slots', ''), fact('exp', 'Time remaining', ''), fact('max', 'Maximum participants', String(g.maxClaimers))),
      h('div', { class: 'bar', 'aria-hidden': 'true' }, barFill),
      h('div', { class: 'links' }, chanBtn('Official channel', 'btn btn--sm'), supBtn('Support', 'btn btn--sm btn--ghost')));

    const refreshFacts = () => {
      const np = pill(g.status); pillNode.replaceWith(np); pillNode = np;
      factVals.avail.textContent = String(g.availableSlots); factVals.claimed.textContent = String(g.claimedCount);
      factVals.exp.textContent = expiryText(g); barFill.style.width = pct(g) + '%';
    };
    refreshFacts();

    const ended = () => g.status === 'EXPIRED' || g.status === 'CANCELLED';

    function outcome(title, text) {
      const others = h('div');
      panel.replaceChildren(h('div', { class: 'pop' },
        h('h2', { text: title }), h('p', { class: 'sub', text }),
        h('div', { class: 'links' }, h('a', { class: 'btn btn--primary', href: '/giveaways', 'data-link': true }, 'Explore Giveaways', ic('arrow')), chanBtn(), supBtn()),
        h('div', { class: 'note' }, ic('gift'), h('span', {}, h('b', { text: 'Want to create your own giveaway? ' }), 'Launch your giveaway and distribute rewards with Veylo. ', h('a', { class: 'grad', ...ext(BOOT.botUrl), text: 'Open the VEYLO Telegram bot →' }))),
        h('h3', { text: 'Other giveaways', style: 'margin-top:22px' }), others));
      fillGiveaways(others, { limit: 2, exclude: slug });
    }

    function showSuccess(c) {
      const timer = h('b', { text: '' }); let copyBtn;
      const expiredAt = new Date(c.expiresAt).getTime();
      copyBtn = h('button', { class: 'btn btn--primary btn--block', type: 'button', onclick: async () => {
        const ok = await copyText(c.code);
        copyBtn.replaceChildren(ic(ok ? 'check' : 'copy'), ok ? 'Copied!' : 'Press and hold the code to copy');
        setTimeout(() => copyBtn.replaceChildren(ic('copy'), 'Copy Code'), 2200);
      } }, ic('copy'), 'Copy Code');
      panel.replaceChildren(h('div', { class: 'pop' },
        h('div', { class: 'tick' }, ic('check')),
        h('h2', { text: 'Your VEYLO claim code is ready!' }),
        h('p', { class: 'sub', text: 'Copy your code and redeem it through our official Telegram bot before it expires.' }),
        h('div', { class: 'code', id: 'code', text: c.code, 'aria-label': 'Claim code' }),
        h('div', { class: 'timer' }, ic('clock'), 'Expires in ', timer),
        h('div', { class: 'stack' }, copyBtn, h('a', { class: 'btn btn--block', ...ext(c.botLink || BOOT.botUrl) }, ic('send'), 'Open VEYLO Bot')),
        h('ol', { class: 'how' }, h('li', { text: 'Copy your code.' }),
          h('li', { text: 'Tap Open VEYLO Bot — your code is passed along. Or choose “Redeem Giveaway Code” in the bot and paste it.' }),
          h('li', { text: 'Confirm your wallet address and receive your reward.' })),
        h('p', { class: 'fine', text: 'Single-use and tied to this giveaway only. Never share it.' }), h('div', { class: 'links' }, supBtn('Need help?', 'btn btn--sm btn--ghost'))));
      const tick = () => {
        const rem = expiredAt - Date.now(); timer.textContent = mmss(rem);
        if (rem <= 0) { store.del('veylo_code_' + slug); showClaim('Your code expired. You can generate a new one if slots are still available.'); }
      };
      tick(); timers.push(setInterval(tick, 1000));
    }

    function showClaim(notice) {
      let busy = false; const errBox = h('div', { class: 'err', hidden: true, role: 'alert' });
      const btn = h('button', { class: 'btn btn--primary btn--block', type: 'button' }, ic('gift'), 'Claim Reward');
      btn.addEventListener('click', async () => {
        if (busy) return; busy = true; btn.disabled = true; errBox.hidden = true;
        btn.replaceChildren(h('span', { class: 'spin' }), 'Reserving your spot…');
        try {
          const r = await api(`/giveaways/${encodeURIComponent(slug)}/claim-code`, { method: 'POST', body: '{}' });
          store.set('veylo_code_' + slug, r); showSuccess(r); refresh();
        } catch (e) {
          busy = false; btn.disabled = false; btn.replaceChildren(ic('gift'), 'Claim Reward');
          if (e.code === 'FULL') { await refresh(); return outcomeFull(); }
          if (e.code === 'EXPIRED') { await refresh(); return outcomeEnded(); }
          errBox.textContent = ({
            NOT_ACTIVE: 'This giveaway is no longer accepting claims.', RATE_LIMITED: 'Too many requests. Please wait a little and try again.',
            DEVICE_LIMIT: 'You have requested several codes for this giveaway. Please use your existing code or try again later.',
            BUSY: 'Lots of people are claiming right now. Please tap Claim Reward again.', DISABLED: 'Claims are temporarily unavailable.',
          })[e.code] || 'Something went wrong. Please try again.';
          errBox.hidden = false;
        }
      });
      panel.replaceChildren(h('div', { class: 'pop' }, h('h2', { text: 'Claim your reward' }),
        h('p', { class: 'sub', text: notice || `Reserve a spot and get a single-use code valid for ${BOOT.reservationMinutes} minutes. No sign-up needed.` }),
        btn, errBox, h('p', { class: 'fine', text: 'Your code is redeemed in the VEYLO Telegram bot, where you confirm your wallet address.' }),
        h('div', { class: 'links' }, botBtn('Open VEYLO Bot', 'btn btn--sm'), supBtn('Support', 'btn btn--sm btn--ghost'))));
    }

    const outcomeFull = () => outcome('This giveaway is full', "This giveaway has filled all available slots. Don't miss the next opportunity. Explore other giveaways or create your own with Veylo.");
    const outcomeEnded = () => outcome(g.status === 'CANCELLED' ? 'This giveaway was cancelled' : 'This giveaway has expired', 'Claims are closed for this giveaway. Explore other active giveaways or follow the channel for the next one.');

    function decide() {
      if (g.status === 'FULL') return outcomeFull();
      if (ended()) return outcomeEnded();
      const saved = store.get('veylo_code_' + slug);
      if (saved && new Date(saved.expiresAt) > Date.now()) return showSuccess(saved);
      store.del('veylo_code_' + slug); showClaim();
    }

    async function refresh() {
      try { const prev = g.status; g = (await api('/giveaways/' + encodeURIComponent(slug))).giveaway; refreshFacts(); return prev !== g.status; }
      catch { return false; }
    }

    app.replaceChildren(h('div', { class: 'view' }, h('div', { class: 'wrap' },
      h('a', { class: 'crumb', href: '/giveaways', 'data-link': true }, '← All giveaways'), h('div', { class: 'detail' }, left1, panel))));
    decide();
    timers.push(setInterval(() => { factVals.exp.textContent = expiryText(g); }, 1000));
    timers.push(setInterval(async () => {
      const changed = await refresh();
      if (changed && !document.querySelector('#code')) decide();
    }, 20000));
  }

  // ── router ──
  function route() {
    clearTimers();
    const p = location.pathname.replace(/\/+$/, '') || '/';
    let m;
    if (p === '/') homeView();
    else if (p === '/giveaways') listView();
    else if ((m = p.match(/^\/g\/([a-z0-9]{6,32})$/))) detailView(m[1]);
    else notFoundView();
    if (location.hash) setTimeout(() => { const t = document.querySelector(location.hash); if (t) t.scrollIntoView(); }, 60);
    else window.scrollTo(0, 0);
    app.focus({ preventScroll: true });
  }
  document.addEventListener('click', (ev) => {
    const a = ev.target.closest && ev.target.closest('a[data-link]');
    if (!a || ev.metaKey || ev.ctrlKey || ev.shiftKey || a.target === '_blank') return;
    const u = new URL(a.href, location.href); if (u.origin !== location.origin) return;
    ev.preventDefault(); history.pushState({}, '', u.pathname + u.hash); route();
  });
  window.addEventListener('popstate', route);

  // global links from server config
  document.querySelectorAll('[data-bot]').forEach((a) => Object.assign(a, { href: BOOT.botUrl, target: '_blank' }));
  document.querySelectorAll('[data-channel]').forEach((a) => Object.assign(a, { href: BOOT.channelUrl, target: '_blank' }));
  document.querySelectorAll('[data-support]').forEach((a) => { if (BOOT.supportUrl) { a.href = BOOT.supportUrl; a.target = '_blank'; a.hidden = false; } });
  document.getElementById('yr').textContent = new Date().getFullYear();
  route();
})();
  
