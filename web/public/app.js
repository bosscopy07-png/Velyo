(() => {
  'use strict';
  const BOOT = JSON.parse(document.getElementById('boot').textContent || '{}');
  const API = (BOOT.apiBase || '') + '/api/v1';
  const app = document.getElementById('app');
  const NS = 'http://www.w3.org/2000/svg';

  // ── tiny DOM helpers (text always via textContent → no HTML injection) ──
  function h(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'style') n.style.cssText = v; // CSSOM — CSP-safe
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

  // ── anonymous device token (rate-limit / idempotency only — never identity) ──
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
  const open = (g) => g.status === 'ACTIVE' || g.status === 'ALMOST_FULL';

  // ── partners (links come ONLY from server configuration) ──
  const botBtn = (label = 'Open VEYLO Bot', cls = 'btn btn--primary') => h('a', { class: cls, ...ext(BOOT.botUrl) }, ic('send'), label);
  const chanBtn = (label = 'Join the Channel', cls = 'btn') => h('a', { class: cls, ...ext(BOOT.channelUrl) }, ic('bell'), label);
  const supBtn = (label = 'Support', cls = 'btn btn--ghost') => (BOOT.supportUrl ? h('a', { class: cls, ...ext(BOOT.supportUrl) }, ic('help'), label) : null);
  const timers = [];
  const clearTimers = () => { while (timers.length) clearInterval(timers.pop()); };

  // ── components ──
  function ring(g) {
    const C = 2 * Math.PI * 46;
    const val = h('circle', {}); const trk = h('circle', {});
    const svg = document.createElementNS(NS, 'svg'); svg.setAttribute('viewBox', '0 0 110 110');
    svg.innerHTML = '<defs><linearGradient id="rg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8B6CFF"/><stop offset="1" stop-color="#22D3EE"/></linearGradient></defs>';
    const mk = (cls) => { const c = document.createElementNS(NS, 'circle'); c.setAttribute('class', cls); c.setAttribute('cx', '55'); c.setAttribute('cy', '55'); c.setAttribute('r', '46'); return c; };
    const t = mk('trk'), v = mk('val'); svg.append(t, v);
    v.style.strokeDasharray = `0 ${C}`;
    requestAnimationFrame(() => requestAnimationFrame(() => { v.style.strokeDasharray = `${(C * pct(g)) / 100} ${C}`; }));
    void val; void trk;
    return h('div', { class: 'ring' }, svg, h('div', { class: 'ring__c' }, h('b', { text: String(g.availableSlots) }), h('span', { text: 'slots left' })));
  }

  function giveawayCard(g) {
    return h('a', { class: 'glass gcard' + (open(g) ? '' : ' gcard--off'), href: '/g/' + g.slug, 'data-link': true },
      h('div', { class: 'gcard__top' }, h('div', { class: 'ico' }, ic('gift')), pill(g.status)),
      h('div', { class: 'amt' }, g.amountPerUser, h('small', { text: g.asset })),
      h('h3', { text: 'per participant · ' + g.title }),
      h('div', { class: 'bar', 'aria-hidden': 'true' }, h('i', { style: `width:${pct(g)}%` })),
      h('div', { class: 'gcard__foot' },
        h('span', {}, ic('users'), `${g.availableSlots} of ${g.maxClaimers} left`),
        h('span', {}, ic('clock'), expiryText(g))));
  }

  const emptyState = (title, msg) => h('div', { class: 'empty' }, h('h3', { text: title }), h('p', { text: msg }),
    h('div', { class: 'links cen' }, chanBtn('Get notified in the channel')));

  async function fillGiveaways(target, { limit, exclude, status } = {}) {
    target.className = '';
    target.replaceChildren(h('div', { class: 'skel' }));
    try {
      const { giveaways } = await api(`/giveaways?limit=${limit || 12}${status ? '&status=' + status : ''}`);
      const list = giveaways.filter((g) => g.slug !== exclude);
      if (!list.length) { target.replaceChildren(emptyState('No active giveaways right now', 'New giveaways are announced in the official channel first.')); return list; }
      target.className = 'grid grid--3'; target.replaceChildren(...list.map(giveawayCard)); return list;
    } catch {
      target.replaceChildren(h('div', { class: 'empty' }, h('p', { text: "We couldn't load giveaways. Please refresh in a moment." }))); return [];
    }
  }

  function featuredCard(g) {
    if (!g) {
      return h('div', { class: 'glass dash' },
        h('div', { class: 'dash__bar' }, h('div', { class: 'dots' }, h('i'), h('i'), h('i')), h('span', { text: 'How a claim works' })),
        h('div', { class: 'stack' },
          ...[['gift', 'Pick a giveaway', 'Live slots and rewards, straight from VEYLO.'], ['copy', 'Copy your code', 'One tap — no account, no wallet, no login.'], ['send', 'Redeem in the bot', 'Confirm your address and get paid via Telegram.']]
            .map(([i, t, d]) => h('div', { class: 'tile', style: 'display:flex;gap:14px;align-items:center;padding:14px' }, h('div', { class: 'ico' }, ic(i)), h('div', {}, h('b', { text: t }), h('span', { text: d }))))));
    }
    return h('a', { class: 'glass dash', href: '/g/' + g.slug, 'data-link': true, style: 'display:block' },
      h('div', { class: 'dash__bar' }, h('span', { class: 'eyebrow live', text: 'Featured giveaway' }), pill(g.status)),
      h('div', { class: 'dash__main' }, ring(g),
        h('div', {}, h('div', { class: 'amt' }, g.amountPerUser, h('small', { text: g.asset })), h('div', { class: 'meta', text: 'per participant' }))),
      h('div', { class: 'tiles' },
        h('div', { class: 'tile' }, h('span', { text: 'Pool' }), h('b', { text: `${g.totalAmount} ${g.asset}` })),
        h('div', { class: 'tile' }, h('span', { text: 'Participants' }), h('b', { text: String(g.maxClaimers) })),
        h('div', { class: 'tile' }, h('span', { text: 'Ends' }), h('b', { text: expiryText(g) }))),
      h('div', { class: 'links' }, h('span', { class: 'btn btn--primary btn--block' }, 'Claim Reward', ic('arrow'))));
  }

  // ── pages ──
  function homeView() {
    const stats = h('div', { class: 'stats', hidden: true });
    const feat = h('div', {}, h('div', { class: 'skel', style: 'height:330px' }));
    const preview = h('div');
    const view = h('div', { class: 'view' },
      h('section', { class: 'hero' }, h('div', { class: 'wrap' },
        h('div', { class: 'hero__grid' },
          h('div', {},
            h('span', { class: 'eyebrow live', text: 'Giveaways · Rewards · Telegram' }),
            h('h1', {}, 'Discover Giveaways. Claim Rewards. Experience ', h('span', { class: 'grad', text: 'VEYLO.' })),
            h('p', { class: 'lead', text: 'Your destination for exciting giveaways and seamless reward distribution. Discover opportunities, claim your code, and complete your reward through the Veylo Telegram bot.' }),
            h('div', { class: 'hero__cta' }, h('a', { class: 'btn btn--primary', href: '/giveaways', 'data-link': true }, 'Explore Giveaways', ic('arrow')), botBtn('Open VEYLO Bot', 'btn')),
            h('div', { class: 'trust' }, h('span', {}, ic('zap'), 'No sign-up'), h('span', {}, ic('lock'), 'Single-use codes'), h('span', {}, ic('shield'), 'Paid via the official bot'))),
          feat),
        stats)),
      h('section', {}, h('div', { class: 'wrap' },
        h('div', { class: 'row-h' }, h('div', { class: 'sec-h' }, h('span', { class: 'eyebrow', text: 'Live now' }), h('h2', { text: 'Active giveaways' })),
          h('a', { class: 'btn btn--sm', href: '/giveaways', 'data-link': true }, 'View all', ic('arrow'))),
        preview)),
      h('section', { id: 'how' }, h('div', { class: 'wrap' },
        h('div', { class: 'sec-h' }, h('span', { class: 'eyebrow', text: 'How it works' }), h('h2', { text: 'Three steps to your reward' })),
        h('div', { class: 'steps' },
          ...[['gift', 'Discover an active giveaway', 'Browse live giveaways with real reward amounts and slot counts.'],
              ['copy', 'Generate and copy your claim code', 'No sign-up. Tap Claim Reward and a secure, single-use code is reserved for you.'],
              ['send', 'Redeem it in the VEYLO Telegram bot', 'Paste the code in the bot, confirm your wallet address, and receive your reward.']]
            .map(([i, t, d]) => h('div', { class: 'glass step' }, h('div', { class: 'ico' }, ic(i)), h('h3', { text: t }), h('p', { class: 'meta', text: d })))),
        h('div', { class: 'note' }, ic('shield'), h('span', { text: 'Rewards are claimed and paid out entirely inside the official VEYLO Telegram bot. The website only gives you a code — it never asks for your wallet, keys or login.' })))),
      h('section', {}, h('div', { class: 'wrap promo' },
        h('div', { class: 'glass' }, h('div', { class: 'ico' }, ic('send')), h('h3', { text: 'The VEYLO Telegram bot' }),
          h('p', { text: 'Redeem codes, confirm your wallet address and receive rewards — fast, inside Telegram.' }), botBtn('Open VEYLO Bot')),
        h('div', { class: 'glass' }, h('div', { class: 'ico' }, ic('bell')), h('h3', { text: 'Official channel' }),
          h('p', { text: 'Stay connected with Veylo. Get the latest giveaway announcements, exclusive rewards, updates, and new opportunities through our official Telegram channel.' }), chanBtn()))),
      h('section', {}, h('div', { class: 'wrap' }, h('div', { class: 'cta' },
        h('h2', { text: 'Want to create your own giveaway?' }), h('p', { text: 'Launch your giveaway and distribute rewards with Veylo.' }), botBtn('Open VEYLO Bot')))),
      BOOT.supportUrl ? h('section', {}, h('div', { class: 'wrap' }, h('div', { class: 'glass help' },
        h('div', {}, h('h3', { text: 'Need help?' }), h('p', { class: 'meta', text: 'Questions about a code or a reward? Our support team is here.' })), supBtn('Contact Support', 'btn')))) : null);
    document.title = 'VEYLO — Discover Giveaways. Claim Rewards.';
    app.replaceChildren(view);
    fillGiveaways(preview, { limit: 3 }).then((list) => { feat.replaceChildren(featuredCard(list.find(open) || null)); });
    api('/stats').then((s) => {
      const t = [];
      if (s.activeGiveaways > 0) t.push(['gift', String(s.activeGiveaways), 'Active giveaways']);
      if (s.giveawaysHosted != null) t.push(['trend', String(s.giveawaysHosted), 'Giveaways hosted']);
      if (s.rewardsDelivered != null) t.push(['users', String(s.rewardsDelivered), 'Rewards delivered']);
      if (s.distributed) t.push(['zap', s.distributed.map((d) => `${d.total} ${d.asset}`).join(' · '), 'Total paid out']);
      if (!t.length) return;
      stats.replaceChildren(...t.map(([i, v, l]) => h('div', { class: 'glass stat' }, h('div', { class: 'ico' }, ic(i)), h('div', {}, h('b', { text: v }), h('span', { text: l })))));
      stats.hidden = false;
    }).catch(() => {});
  }

  function listView() {
    const grid = h('div'); const chips = h('div', { class: 'chips' }); let all = [], mode = 'all';
    const render = () => {
      const list = all.filter((g) => (mode === 'all' ? true : mode === 'active' ? open(g) : !open(g)));
      grid.className = list.length ? 'grid grid--3' : '';
      grid.replaceChildren(...(list.length ? list.map(giveawayCard) : [emptyState(mode === 'ended' ? 'Nothing here yet' : 'No giveaways in this view', 'New giveaways are announced in the official channel first.')]));
      [...chips.children].forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.m === mode)));
    };
    [['all', 'All'], ['active', 'Active'], ['ended', 'Ended']].forEach(([m, l]) => chips.append(h('button', { class: 'chip', type: 'button', 'data-m': m, 'aria-pressed': String(m === mode), text: l, onclick: () => { mode = m; render(); } })));
    app.replaceChildren(h('div', { class: 'view' }, h('section', {}, h('div', { class: 'wrap' },
      h('div', { class: 'row-h' }, h('div', { class: 'sec-h' }, h('span', { class: 'eyebrow live', text: 'Giveaways' }), h('h2', { text: 'Discover giveaways' }),
        h('p', { text: 'Live data straight from VEYLO. Slot counts and status update as people claim.' })), chips), grid))));
    document.title = 'Giveaways — VEYLO';
    grid.replaceChildren(h('div', { class: 'skel' }));
    api('/giveaways?status=all&limit=30').then((r) => { all = r.giveaways; if (!all.some(open)) mode = 'all'; render(); })
      .catch(() => grid.replaceChildren(h('div', { class: 'empty' }, h('p', { text: "We couldn't load giveaways. Please refresh in a moment." }))));
  }

  function notFoundView(msg) {
    app.replaceChildren(h('div', { class: 'view' }, h('section', {}, h('div', { class: 'wrap' }, h('div', { class: 'empty' },
      h('h3', { text: msg || 'Page not found' }), h('p', { text: 'The link may be wrong or the giveaway is no longer available.' }),
      h('div', { class: 'links cen' }, h('a', { class: 'btn btn--primary', href: '/giveaways', 'data-link': true }, 'Explore Giveaways'), supBtn()))))));
    document.title = 'Not found — VEYLO';
  }

  async function copyText(t) {
    try { await navigator.clipboard.writeText(t); return true; } catch { /* fall through */ }
    const ta = h('textarea', { readonly: true, 'aria-hidden': 'true', style: 'position:fixed;opacity:0;top:0' }); ta.value = t;
    document.body.append(ta); ta.select(); ta.setSelectionRange(0, 99);
    let ok = false; try { ok = document.execCommand('copy'); } catch { /* ignore */ }
    ta.remove(); return ok;
  }

  const stepper = (n) => h('div', { class: 'stepper', 'aria-label': 'Progress' },
    ...[['Claim', 1], ['Copy', 2], ['Redeem', 3]].flatMap(([l, i], k) => [
      k ? h('i') : null,
      h('span', { class: i < n ? 'done' : i === n ? 'on' : '' }, h('b', { text: i < n ? '✓' : String(i) }), l)]));

  async function detailView(slug) {
    app.replaceChildren(h('div', { class: 'wrap' }, h('div', { class: 'skel', style: 'margin-top:40px;height:340px' })));
    let g;
    try { g = (await api('/giveaways/' + encodeURIComponent(slug))).giveaway; }
    catch (e) { return notFoundView(e.status === 404 ? 'Giveaway not found' : 'Something went wrong'); }
    document.title = `${g.title} — VEYLO`;

    const vals = {};
    const fact = (key, label, val) => { const b = h('b', { text: val }); vals[key] = b; return h('div', { class: 'fact' }, h('span', { text: label }), b); };
    const barFill = h('i'); let pillNode = pill(g.status);
    const slotsL = h('span'), slotsR = h('span');
    const panel = h('div', { class: 'glass panel sticky' });

    const overview = h('div', { class: 'glass ov' },
      h('div', { class: 'ov__head' }, h('div', { class: 'ico' }, ic('gift')), pillNode),
      h('h1', { text: g.title }),
      h('p', { class: 'sub', text: 'Claim a code here, then redeem it in the VEYLO Telegram bot to receive your reward.' }),
      h('div', { class: 'facts' },
        fact('amt', 'Reward per participant', `${g.amountPerUser} ${g.asset}`), fact('pool', 'Total reward pool', `${g.totalAmount} ${g.asset}`),
        fact('exp', 'Time remaining', ''), fact('avail', 'Available slots', ''), fact('claimed', 'Claimed slots', ''), fact('max', 'Maximum participants', String(g.maxClaimers))),
      h('div', { class: 'slots' }, slotsL, slotsR), h('div', { class: 'bar', 'aria-hidden': 'true' }, barFill),
      h('div', { class: 'links' }, chanBtn('Official channel', 'btn btn--sm'), supBtn('Support', 'btn btn--sm btn--ghost')));

    const refreshFacts = () => {
      const np = pill(g.status); pillNode.replaceWith(np); pillNode = np;
      vals.avail.textContent = String(g.availableSlots); vals.claimed.textContent = String(g.claimedCount);
      vals.exp.textContent = expiryText(g); barFill.style.width = pct(g) + '%';
      slotsL.textContent = `${pct(g)}% filled`; slotsR.textContent = `${g.availableSlots} of ${g.maxClaimers} slots left`;
    };
    refreshFacts();

    const ended = () => g.status === 'EXPIRED' || g.status === 'CANCELLED';

    function outcome(title, text) {
      const others = h('div');
      panel.replaceChildren(h('div', { class: 'pop' },
        h('h2', { text: title }), h('p', { class: 'sub', text }),
        h('div', { class: 'links' }, h('a', { class: 'btn btn--primary', href: '/giveaways', 'data-link': true }, 'Explore Giveaways', ic('arrow')), chanBtn(), supBtn()),
        h('div', { class: 'note' }, ic('gift'), h('span', {}, h('b', { text: 'Want to create your own giveaway? ' }), 'Launch your giveaway and distribute rewards with Veylo. ', h('a', { class: 'grad', ...ext(BOOT.botUrl), text: 'Open the VEYLO Telegram bot →' }))),
        h('h3', { text: 'Other giveaways', style: 'margin:24px 0 14px' }), others));
      fillGiveaways(others, { limit: 2, exclude: slug, status: 'open' }).then(() => { others.className = others.className.replace('grid--3', '') ; });
    }

    function showSuccess(c) {
      const timer = h('b', { text: '' }); let copyBtn;
      const expiredAt = new Date(c.expiresAt).getTime();
      copyBtn = h('button', { class: 'btn btn--primary btn--block', type: 'button', onclick: async () => {
        const ok = await copyText(c.code);
        copyBtn.replaceChildren(ic(ok ? 'check' : 'copy'), ok ? 'Copied!' : 'Press and hold the code to copy');
        setTimeout(() => copyBtn.replaceChildren(ic('copy'), 'Copy Code'), 2200);
      } }, ic('copy'), 'Copy Code');
      panel.replaceChildren(h('div', { class: 'pop' }, stepper(2),
        h('div', { class: 'tick' }, ic('check')),
        h('h2', { text: 'Your VEYLO claim code is ready!' }),
        h('p', { class: 'sub', text: 'Copy your code and redeem it through our official Telegram bot before it expires.' }),
        h('div', { class: 'code', id: 'code', text: c.code, 'aria-label': 'Claim code' }),
        h('div', { class: 'timer' }, ic('clock'), 'Expires in ', timer),
        h('div', { class: 'stack' }, copyBtn, h('a', { class: 'btn btn--block', ...ext(c.botLink || BOOT.botUrl) }, ic('send'), 'Open VEYLO Bot')),
        h('ol', { class: 'how' }, h('li', { text: 'Copy your code.' }),
          h('li', { text: 'Tap Open VEYLO Bot — your code is passed along. Or open Giveaway → “Redeem Giveaway Code” in the bot and paste it.' }),
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
      panel.replaceChildren(h('div', { class: 'pop' }, stepper(1), h('h2', { text: 'Claim your reward' }),
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
      h('a', { class: 'crumb', href: '/giveaways', 'data-link': true }, '← All giveaways'), h('div', { class: 'detail' }, overview, panel))));
    decide();
    timers.push(setInterval(() => { vals.exp.textContent = expiryText(g); }, 1000));
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
    document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('on', p === '/' + a.dataset.nav || p.startsWith('/g/')));
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

  document.querySelectorAll('[data-bot]').forEach((a) => Object.assign(a, { href: BOOT.botUrl, target: '_blank' }));
  document.querySelectorAll('[data-channel]').forEach((a) => Object.assign(a, { href: BOOT.channelUrl, target: '_blank' }));
  document.querySelectorAll('[data-support]').forEach((a) => { if (BOOT.supportUrl) { a.href = BOOT.supportUrl; a.target = '_blank'; a.hidden = false; } });
  document.getElementById('yr').textContent = new Date().getFullYear();
  route();
})();
        
