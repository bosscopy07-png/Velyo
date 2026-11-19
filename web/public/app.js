(() => {
  'use strict';
  const BOOT = JSON.parse(document.getElementById('boot').textContent || '{}');
  const API = (BOOT.apiBase || '') + '/api/v1';
  const app = document.getElementById('app');
  const NS = 'http://www.w3.org/2000/svg';
  document.documentElement.classList.add('js');

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
    if (!res.ok) throw Object.assign(new Error('api'), { status: res.status, code: body && body.error, data: body });
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
  const ngn = (n) => (n == null ? '' : '≈ ₦' + Number(n).toLocaleString('en-NG'));
  const ADDR = /^0x[0-9a-fA-F]{40}$/;
  const short = (t) => (t && t.length > 20 ? t.slice(0, 10) + '…' + t.slice(-8) : t || '');
  const open = (g) => g.status === 'ACTIVE' || g.status === 'ALMOST_FULL';

  // ── partners (links come ONLY from server configuration) ──
  const botBtn = (label = 'Open VEYLO Bot', cls = 'btn btn--primary') => h('a', { class: cls, ...ext(BOOT.botUrl) }, ic('send'), label);
  const chanBtn = (label = 'Join the Channel', cls = 'btn') => h('a', { class: cls, ...ext(BOOT.channelUrl) }, ic('bell'), label);
  const supBtn = (label = 'Support', cls = 'btn btn--ghost') => (BOOT.supportUrl ? h('a', { class: cls, ...ext(BOOT.supportUrl) }, ic('help'), label) : null);
  const timers = [];
  const clearTimers = () => { while (timers.length) clearInterval(timers.pop()); };

  // ── pages ──
  function homeView() {
    const stats = h('div', { class: 'stats', hidden: true });
    const view = h('div', { class: 'view' },
      h('section', { class: 'hero' }, h('div', { class: 'wrap' },
        h('div', { class: 'hero__grid' },
          h('div', {},
            h('span', { class: 'eyebrow live', text: 'Telegram giveaway platform' }),
            h('h1', {}, 'Create a giveaway. Share the link. ', h('span', { class: 'grad', text: 'Reward your community.' })),
            h('p', { class: 'lead', text: 'VEYLO is a Telegram giveaway platform. Deposit USDT or BNB, create a giveaway in seconds, and share your link — your community claims and gets paid straight to their wallets.' }),
            h('div', { class: 'hero__cta' }, botBtn('Create a Giveaway'), chanBtn('Join the Channel')),
            h('div', { class: 'trust' }, h('span', {}, ic('zap'), 'Create it all in Telegram'), h('span', {}, ic('send'), 'One link to share'), h('span', {}, ic('shield'), 'Paid straight to wallets'))),
          h('div', { class: 'glass dash glow' },
            h('div', { class: 'dash__bar' }, h('span', { class: 'eyebrow live', text: 'How a giveaway works' }), h('div', { class: 'dots' }, h('i'), h('i'), h('i'))),
            h('div', { class: 'stack' },
              ...[['trend', 'Deposit', 'Add USDT or BNB to your VEYLO wallet in the bot.'], ['gift', 'Create', 'Set the amount, number of winners and how long it runs.'], ['send', 'Share', 'Post your link anywhere. People claim and get paid.']]
                .map(([i, t, d], k) => h('div', { class: 'tile flowrow' }, h('div', { class: 'ico' }, ic(i)), h('div', {}, h('b', { text: `${k + 1}. ${t}` }), h('span', { text: d }))))),
            h('div', { class: 'note' }, ic('lock'), h('span', { text: 'Got a giveaway link? Open the link your host shared to claim — there is nothing to browse here.' })))),
        stats)),
      h('section', { id: 'how' }, h('div', { class: 'wrap' },
        h('div', { class: 'sec-h' }, h('span', { class: 'eyebrow', text: 'How it works' }), h('h2', { text: 'From deposit to payout in four steps' }),
          h('p', { text: 'Everything is done in the official VEYLO Telegram bot. This website is simply the claim page that opens from a giveaway link.' })),
        h('div', { class: 'steps steps--4' },
          ...[['trend', 'Deposit', 'Add USDT or BNB to your VEYLO wallet inside the Telegram bot.'],
              ['gift', 'Create', 'Choose the reward, how many people can claim, and how long it runs.'],
              ['send', 'Share', 'Copy your giveaway link and post it in your group, channel or chats.'],
              ['check', 'Get claimed', 'Your community claims and is paid to their own wallets. You follow it all in your stats.']]
            .map(([i, t, d]) => h('div', { class: 'glass step' }, h('div', { class: 'ico' }, ic(i)), h('h3', { text: t }), h('p', { class: 'meta', text: d })))))),
      h('section', { id: 'claim' }, h('div', { class: 'wrap' }, h('div', { class: 'glass claimbox' },
        h('div', {}, h('span', { class: 'eyebrow', text: 'Received a giveaway link?' }), h('h2', { text: 'Claiming takes under a minute' }),
          h('ol', { class: 'how' },
            h('li', { text: 'Open the giveaway link your host shared with you.' }),
            h('li', { text: 'Enter your BEP20 wallet address to get a single-use claim code.' }),
            h('li', { text: 'Redeem the code in the VEYLO bot and receive your reward.' }))),
        h('div', { class: 'stack' }, botBtn('Open VEYLO Bot'), chanBtn('Official channel', 'btn'))))),
      h('section', {}, h('div', { class: 'wrap' },
        h('div', { class: 'sec-h' }, h('span', { class: 'eyebrow', text: 'Why VEYLO' }), h('h2', {}, 'Built for hosts who want ', h('span', { class: 'grad', text: 'fair, fast' }), ' giveaways'),
          h('p', { text: 'Every detail is designed so your rewards reach real people — quickly, safely and transparently.' })),
        h('div', { class: 'feats' },
          ...[['zap', 'Set up in seconds', 'Deposit, create and share without ever leaving Telegram.'],
              ['shield', 'Fair by design', 'One claim per wallet in each giveaway. Duplicate attempts are blocked automatically.'],
              ['lock', 'Single-use codes', 'Every claim code belongs to one giveaway and can’t be reused or transferred.'],
              ['send', 'Automatic payouts', 'Rewards go straight to each claimer’s wallet, with a receipt showing the transaction hash.'],
              ['trend', 'Live statistics', 'Track link opens, claim attempts, payouts and spots remaining for every giveaway.'],
              ['users', 'Earn as you grow', 'Earn referral rewards when people you bring go on to host giveaways of their own.']]
            .map(([i, t, d]) => h('div', { class: 'glass feat' }, h('div', { class: 'ico' }, ic(i)), h('h3', { text: t }), h('p', { text: d })))))),
      h('section', {}, h('div', { class: 'wrap' }, h('div', { class: 'earn' }, h('div', { class: 'earn__grid' },
        h('div', {},
          h('span', { class: 'eyebrow live', text: 'Earn with VEYLO' }),
          h('h2', {}, 'Create giveaways. ', h('span', { class: 'grad', text: 'Earn as you grow.' })),
          h('p', { class: 'lead', text: 'Launch a giveaway in the VEYLO bot, share one link, and let your community claim in seconds. When people who joined through your giveaway go on to host their own, you earn referral rewards.' }),
          h('ul', {},
            ...[['Launch in under a minute', 'Set the amount, winners and time right inside Telegram.'],
                ['Share one link', 'It opens a clean claim page for your community — no sign-ups.'],
                ['Earn referral rewards', 'Grow your network and earn as your referrals host giveaways.']]
              .map(([t, d]) => h('li', {}, ic('check'), h('div', {}, h('b', { text: t + ' ' }), h('span', { text: d }))))),
          h('div', { class: 'hero__cta' }, botBtn('Create a Giveaway'), h('a', { class: 'btn', href: '#how', 'data-link': true }, 'See how it works'))),
        h('div', { class: 'orbit', 'aria-hidden': 'true' }, h('div', { class: 'orbit__core' }, ic('gift')),
          h('div', { class: 'bub' }, ic('users')), h('div', { class: 'bub' }, ic('trend')), h('div', { class: 'bub' }, ic('zap'))))))),
      h('section', {}, h('div', { class: 'wrap promo' },
        h('div', { class: 'glass' }, h('div', { class: 'ico' }, ic('send')), h('h3', { text: 'The VEYLO Telegram bot' }),
          h('p', { text: 'Deposit, create giveaways, redeem codes and track everything — all inside Telegram.' }), botBtn('Open VEYLO Bot')),
        h('div', { class: 'glass' }, h('div', { class: 'ico' }, ic('bell')), h('h3', { text: 'Official channel' }),
          h('p', { text: 'Stay connected with VEYLO. Get updates, new features and announcements through our official Telegram channel.' }), chanBtn()))),
      h('section', {}, h('div', { class: 'wrap' }, h('div', { class: 'cta' },
        h('h2', { text: 'Ready to create your first giveaway?' }), h('p', { text: 'Open the VEYLO bot, deposit, and launch your giveaway in minutes.' }), botBtn('Create a Giveaway')))),
      BOOT.supportUrl ? h('section', {}, h('div', { class: 'wrap' }, h('div', { class: 'glass help' },
        h('div', {}, h('h3', { text: 'Need help?' }), h('p', { class: 'meta', text: 'Questions about a giveaway, a code or a payout? Our support team is here.' })), supBtn('Contact Support', 'btn')))) : null);
    document.title = 'VEYLO — Create Giveaways. Share the Link. Reward Your Community.';
    app.replaceChildren(view);
    api('/stats').then((s) => {
      const t = [];
      if (s.giveawaysHosted != null) t.push(['trend', String(s.giveawaysHosted), 'Giveaways hosted']);
      if (s.rewardsDelivered != null) t.push(['users', String(s.rewardsDelivered), 'Rewards delivered']);
      if (s.distributed) t.push(['zap', s.distributed.map((d) => `${d.total} ${d.asset}`).join(' · '), 'Total paid out']);
      if (!t.length) return;
      stats.replaceChildren(...t.map(([i, v, l]) => { const b = h('b', { text: v }); if (/^\d+$/.test(v)) countUp(b, Number(v)); return h('div', { class: 'glass stat' }, h('div', { class: 'ico' }, ic(i)), h('div', {}, b, h('span', { text: l }))); }));
      stats.hidden = false;
    }).catch(() => {});
  }

  function notFoundView(msg) {
    app.replaceChildren(h('div', { class: 'view' }, h('section', {}, h('div', { class: 'wrap' }, h('div', { class: 'empty' },
      h('h3', { text: msg || 'Page not found' }), h('p', { text: 'The link may be wrong or the giveaway is no longer available.' }),
      h('div', { class: 'links cen' }, h('a', { class: 'btn btn--primary', href: '/', 'data-link': true }, 'Go to VEYLO'), supBtn()))))));
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
    ...[['Wallet', 1], ['Code', 2], ['Redeem', 3]].flatMap(([l, i], k) => [
      k ? h('i') : null,
      h('span', { class: i < n ? 'done' : i === n ? 'on' : '' }, h('b', { text: i < n ? '✓' : String(i) }), l)]));

  
async function detailView(slug) {
    app.replaceChildren(h('div', { class: 'wrap' }, h('div', { class: 'skel', style: 'margin-top:40px;height:340px' })));
    let g;
    try { g = (await api('/giveaways/' + encodeURIComponent(slug))).giveaway; }
    catch (e) { return notFoundView(e.status === 404 ? 'Giveaway not found' : 'Something went wrong'); }
    document.title = `${g.title} — VEYLO`;
    try { // count this visit once per browser session (the server also de-duplicates per hour)
      if (!sessionStorage.getItem('veylo_v_' + slug)) { sessionStorage.setItem('veylo_v_' + slug, '1'); api('/giveaways/' + encodeURIComponent(slug) + '/view', { method: 'POST', body: '{}' }).catch(() => {}); }
    } catch { /* ignore */ }

    const vals = {};
    const fact = (key, label, val, sub) => { const b = h('b', { text: val }); vals[key] = b; return h('div', { class: 'fact' }, h('span', { text: label }), b, sub ? h('em', { class: 'ngn', text: sub }) : null); };
    const barFill = h('i'); let pillNode = pill(g.status);
    const slotsL = h('span'), slotsR = h('span');
    const panel = h('div', { class: 'glass panel sticky' });

    const overview = h('div', { class: 'glass ov' },
      h('div', { class: 'ov__head' }, h('div', { class: 'ico' }, ic('gift')), pillNode),
      h('h1', { text: g.title }),
      h('p', { class: 'sub', text: 'Claim a code here, then redeem it in the VEYLO Telegram bot to receive your reward.' }),
      h('div', { class: 'facts' },
        fact('amt', 'Reward per claim', `${g.amountPerUser} ${g.asset}`, ngn(g.amountPerUserNgn)), fact('pool', 'Total reward pool', `${g.totalAmount} ${g.asset}`, ngn(g.totalAmountNgn)),
        fact('exp', 'Time remaining', ''), fact('avail', 'Available slots', ''), fact('claimed', 'Claimed slots', ''), fact('max', 'Total slots', String(g.maxClaimers))),
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

    function outcome(title, text, again) {
      panel.replaceChildren(h('div', { class: 'pop' },
        h('h2', { text: title }), h('p', { class: 'sub', text }),
        h('div', { class: 'links' },
          again ? h('button', { class: 'btn btn--primary', type: 'button', onclick: async () => { await refresh(); decide(); } }, ic('clock'), 'Check again') : null,
          botBtn('Create your own giveaway', again ? 'btn' : 'btn btn--primary'), chanBtn(), supBtn()),
        h('div', { class: 'note' }, ic('gift'), h('span', {}, h('b', { text: 'Want to create your own giveaway? ' }), 'Launch your giveaway and distribute rewards with Veylo. ', h('a', { class: 'grad', ...ext(BOOT.botUrl), text: 'Open the VEYLO Telegram bot →' })))));
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
          h('li', { text: 'Confirm the same wallet address' + (c.maskedAddress ? ` (${c.maskedAddress})` : '') + ' and receive your reward.' })),
        h('p', { class: 'fine', text: 'Single-use and tied to this giveaway only. Never share it.' }), h('div', { class: 'links' }, supBtn('Need help?', 'btn btn--sm btn--ghost'))));
      const tick = () => {
        const rem = expiredAt - Date.now(); timer.textContent = mmss(rem);
        if (rem <= 0) { store.del('veylo_code_' + slug); showClaim('Your code expired. You can generate a new one if slots are still available.'); }
      };
      tick(); timers.push(setInterval(tick, 1000));
      timers.push(setInterval(async () => {
        if (document.hidden) return;
        try {
          const st = await api('/code-status', { method: 'POST', body: JSON.stringify({ code: c.code }) });
          if (st.state === 'REDEEMED') { clearTimers(); showRedeemed(c, st); }
        } catch { /* keep showing the code */ }
      }, 8000));
    }

    // After the code was redeemed in the bot: progress → receipt (amount, wallet, transaction hash).
    function showRedeemed(c, st) {
      const paid = st.progress === 'PAID';
      const body = [stepper(paid ? 4 : 3)];
      if (paid) {
        const hashOk = /^0x[0-9a-fA-F]{64}$/.test(st.txHash || '');
        body.push(h('div', { class: 'tick' }, ic('check')), h('h2', { text: 'Reward received!' }),
          h('p', { class: 'sub', text: 'Your reward has been sent. Here is your payment receipt.' }),
          h('div', { class: 'receipt' },
            h('div', {}, h('span', { text: 'Amount paid' }), h('b', { text: `${st.amount} ${st.asset}` }), st.amountNgn ? h('em', { class: 'ngn', text: ngn(st.amountNgn) }) : null),
            h('div', {}, h('span', { text: 'Paid to wallet' }), h('code', { text: st.wallet || c.maskedAddress || '' })),
            hashOk ? h('div', {}, h('span', { text: 'Transaction hash' }), h('code', { text: st.txHash })) : null),
          h('div', { class: 'stack' },
            hashOk ? h('button', { class: 'btn btn--primary btn--block', type: 'button', onclick: async (ev) => { const b = ev.currentTarget; const ok = await copyText(st.txHash); b.replaceChildren(ic(ok ? 'check' : 'copy'), ok ? 'Copied!' : 'Press and hold the hash'); setTimeout(() => b.replaceChildren(ic('copy'), 'Copy transaction hash'), 2200); } }, ic('copy'), 'Copy transaction hash') : null,
            hashOk ? h('a', { class: 'btn btn--block', ...ext('https://bscscan.com/tx/' + st.txHash) }, ic('arrow'), 'View on BscScan') : null,
            botBtn('Create your own giveaway', 'btn btn--block')),
          h('div', { class: 'links' }, chanBtn('Official channel', 'btn btn--sm'), supBtn('Support', 'btn btn--sm btn--ghost')));
      } else if (st.progress === 'FAILED') {
        body.push(h('h2', { text: 'This claim couldn’t be completed' }),
          h('p', { class: 'sub', text: 'Something stopped this claim from being paid. Please contact support so we can help.' }),
          h('div', { class: 'links' }, supBtn('Contact Support', 'btn btn--primary'), botBtn('Open VEYLO Bot', 'btn')));
      } else {
        const proc = st.progress === 'PROCESSING';
        body.push(h('h2', { text: proc ? 'Payment in progress…' : 'Code redeemed — one last step' }),
          h('p', { class: 'sub', text: proc ? 'Your payout is being processed. This page updates automatically.' : 'Open the VEYLO bot and confirm your wallet address to receive your reward.' }),
          proc ? h('div', { class: 'timer' }, h('span', { class: 'spin spin--lt' }), 'Processing') : null,
          h('div', { class: 'stack' }, botBtn('Open VEYLO Bot', 'btn btn--primary btn--block')));
      }
      panel.replaceChildren(h('div', { class: 'pop' }, ...body));
      if (!paid && st.progress !== 'FAILED') {
        timers.push(setInterval(async () => {
          if (document.hidden) return;
          try {
            const next = await api('/code-status', { method: 'POST', body: JSON.stringify({ code: c.code }) });
            if (next.state === 'REDEEMED' && next.progress !== st.progress) { clearTimers(); showRedeemed(c, next); }
          } catch { /* retry next tick */ }
        }, 8000));
      }
    }

    function showClaim(notice) {
      let busy = false; const errBox = h('div', { class: 'err', hidden: true, role: 'alert' });
      const input = h('input', { class: 'field', type: 'text', autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', maxlength: '42', placeholder: '0x… your BEP20 wallet address', 'aria-label': 'Your BEP20 wallet address' });
      const btn = h('button', { class: 'btn btn--primary btn--block', type: 'button', disabled: true }, ic('gift'), 'Generate Claim Code');
      const ok = () => ADDR.test(input.value.trim());
      input.addEventListener('input', () => { btn.disabled = busy || !ok(); errBox.hidden = true; });
      btn.addEventListener('click', async () => {
        if (busy || !ok()) return; busy = true; btn.disabled = true; errBox.hidden = true;
        btn.replaceChildren(h('span', { class: 'spin' }), 'Reserving your spot…');
        try {
          const r = await api(`/giveaways/${encodeURIComponent(slug)}/claim-code`, { method: 'POST', body: JSON.stringify({ address: input.value.trim() }) });
          store.set('veylo_code_' + slug, r); showSuccess(r); refresh();
        } catch (e) {
          busy = false; btn.disabled = !ok(); btn.replaceChildren(ic('gift'), 'Generate Claim Code');
          if (e.code === 'FULL') { await refresh(); return outcomeFull(e.data && e.data.mayReopen); }
          if (e.code === 'EXPIRED') { await refresh(); return outcomeEnded(); }
          errBox.textContent = ({
            INVALID_ADDRESS: 'That doesn’t look like a valid BEP20 wallet address. Please copy it again from your wallet app.',
            NOT_ACTIVE: 'This giveaway is no longer accepting claims.', RATE_LIMITED: 'Too many requests. Please wait a little and try again.',
            DEVICE_LIMIT: 'This device already has a code for this giveaway. Use that code, or try again after it expires.',
            IP_LIMIT: 'The maximum number of claims from this network has been reached for this giveaway.',
            ADDRESS_USED: 'A code for this wallet is already active. Please use the device where you created it.',
            ALREADY_CLAIMED: 'This wallet or device has already claimed this giveaway. Each person can claim once.',
            BUSY: 'Lots of people are claiming right now. Please tap Generate Claim Code again.', DISABLED: 'Claims are temporarily unavailable.',
          })[e.code] || 'Something went wrong. Please try again.';
          errBox.hidden = false;
        }
      });
      panel.replaceChildren(h('div', { class: 'pop' }, stepper(1), h('h2', { text: 'Claim your reward' }),
        h('p', { class: 'sub', text: notice || 'Enter the wallet address that will receive your reward. Your claim code is generated right after.' }),
        h('label', { class: 'lbl', text: 'BEP20 wallet address (BNB Smart Chain)' }), input,
        h('p', { class: 'fine', text: 'Open your wallet app, copy your BEP20 address and paste it here. Your reward is sent to this exact address — double-check it. You’ll use the same address in the bot.' }),
        btn, errBox,
        h('div', { class: 'links' }, botBtn('Open VEYLO Bot', 'btn btn--sm'), supBtn('Support', 'btn btn--sm btn--ghost'))));
    }

    const outcomeFull = (reopen) => (reopen
      ? outcome('Just missed it — every spot is taken', "You were a moment too late: all spots are currently claimed. Codes that aren't redeemed within " + BOOT.reservationMinutes + " minutes expire and the spot opens up again, so it's worth checking back shortly.", true)
      : outcome('This giveaway is full', "This giveaway has filled all available slots. Don't miss the next one — follow the official channel, or create your own giveaway with VEYLO."));
    const outcomeEnded = () => outcome(g.status === 'CANCELLED' ? 'This giveaway was cancelled' : 'This giveaway has expired', 'Claims are closed for this giveaway. Follow the official channel to catch the next one, or create your own in the VEYLO bot.');

    function decide() {
      if (g.status === 'FULL') return outcomeFull(g.reopenPossible);
      if (ended()) return outcomeEnded();
      const saved = store.get('veylo_code_' + slug);
      if (!saved) return showClaim();
      return api('/code-status', { method: 'POST', body: JSON.stringify({ code: saved.code }) }).then((st) => {
        if (st.state === 'ACTIVE') return showSuccess({ ...saved, expiresAt: st.expiresAt });
        if (st.state === 'REDEEMED') return showRedeemed(saved, st);
        store.del('veylo_code_' + slug); return showClaim(st.state === 'EXPIRED' ? 'Your previous code expired. Enter your wallet address to get a new one.' : undefined);
      }).catch(() => {
        if (new Date(saved.expiresAt) > Date.now()) return showSuccess(saved); // offline: fall back to the local copy
        store.del('veylo_code_' + slug); return showClaim();
      });
    }

    async function refresh() {
      try { const prev = g.status; g = (await api('/giveaways/' + encodeURIComponent(slug))).giveaway; refreshFacts(); return prev !== g.status; }
      catch { return false; }
    }

    app.replaceChildren(h('div', { class: 'view' }, h('div', { class: 'wrap' },
      h('a', { class: 'crumb', href: '/', 'data-link': true }, '← VEYLO'), h('div', { class: 'detail' }, overview, panel))));
    decide();
    timers.push(setInterval(() => { vals.exp.textContent = expiryText(g); }, 1000));
    timers.push(setInterval(async () => {
      if (document.hidden) return; // idle tabs don't poll
      const changed = await refresh();
      if (changed && !document.querySelector('#code') && !document.querySelector('.receipt')) decide();
    }, 25000 + Math.floor(Math.random() * 10000))); // jitter spreads load
  }

  // ── polish: scroll reveal, count-up numbers, card spotlight ──
  const reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  let io = null;
  function reveal() {
    const els = [...document.querySelectorAll('.view .wrap > *, .gcard, .step, .stat, .feat, .earn')].filter((el) => !el.classList.contains('rv'));
    if (!('IntersectionObserver' in window) || reduce) { els.forEach((el) => el.classList.add('rv', 'in')); return; }
    io = io || new IntersectionObserver((entries) => entries.forEach((en) => { if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); } }), { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    els.forEach((el, i) => { el.classList.add('rv'); el.style.transitionDelay = Math.min(i % 6, 5) * 70 + 'ms'; io.observe(el); });
  }
  function countUp(el, target) {
    if (reduce || !Number.isFinite(target) || target < 2) { el.textContent = String(target); return; }
    const t0 = performance.now(), D = 1100;
    const step = (t) => { const k = Math.min(1, (t - t0) / D); el.textContent = String(Math.round(target * (1 - Math.pow(1 - k, 3)))); if (k < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }
  document.addEventListener('pointermove', (ev) => {
    const c = ev.target.closest && ev.target.closest('.glass'); if (!c) return;
    const r = c.getBoundingClientRect(); c.style.setProperty('--mx', ev.clientX - r.left + 'px'); c.style.setProperty('--my', ev.clientY - r.top + 'px');
  }, { passive: true });

  // ── router ──
  function route() {
    clearTimers();
    const p = location.pathname.replace(/\/+$/, '') || '/';
    let m;
    
    if (p === '/') homeView();
    else if (p === '/giveaways') { history.replaceState({}, '', '/'); homeView(); }
    else if ((m = p.match(/^\/g\/([a-z0-9]{6,32})$/))) detailView(m[1]);
    else notFoundView();
    if (location.hash) setTimeout(() => { const t = document.querySelector(location.hash); if (t) t.scrollIntoView(); }, 60);
    else window.scrollTo(0, 0);
    app.focus({ preventScroll: true });
    requestAnimationFrame(() => requestAnimationFrame(reveal));
    setTimeout(reveal, 900); // pick up content that renders after data loads
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
            
