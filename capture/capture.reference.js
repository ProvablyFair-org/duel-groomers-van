// Capture methodology, published for provenance/review.
// Reference record, not a runnable tool.
// Dataset in `data/`, hash-verified by the suite.

if (window._groomerskill) window._groomerskill();

(function () {
  'use strict';

  var INSTANCE = Date.now();
  window._groomerskill = function () { INSTANCE = -1; };

  // ── Phase config ─────────────────────────────────────────────────────────
  // FULL CAPTURE — Option 1 lean plan, ~$2,540 wagered total.
  //   A: 5,000 baseline spins @ $0.20 = $1,000
  //   B: 30 staircased bracket spins (5 each at 6 stake levels) ≈ $557.50
  //   C: 20 buy-bonuses @ $0.20×125 = $500 (each triggers 10 free spins,
  //      drained automatically by playOutBonus → 220 bet records total)
  //   D: 500 spins across 10 custom client seeds (50 per seed) = $100
  //   E: 200 edge-case spins @ $0.20 = $40
  // Total: ~5,750 bets + ~200 free spins + ~120 epoch rotations.
  // Wall time: ~3 hours.
  var PHASES = [
    { key: 'A', name: 'Baseline',            total: 5000, stakes: ['0.20'],                                            mode: 'spin', customSeeds: false },
    { key: 'B', name: 'Bracket sampling',    total: 30,   stakes: ['1.00','1.00','1.00','1.00','1.00',
                                                                   '5.00','5.00','5.00','5.00','5.00',
                                                                   '9.50','9.50','9.50','9.50','9.50',
                                                                   '18.50','18.50','18.50','18.50','18.50',
                                                                   '27.50','27.50','27.50','27.50','27.50',
                                                                   '50.00','50.00','50.00','50.00','50.00'],            mode: 'spin', customSeeds: false },
    { key: 'C', name: 'Buy-bonus',           total: 20,   stakes: ['0.20'],                                            mode: 'buy',  customSeeds: false },
    { key: 'D', name: 'Custom client seeds', total: 500,  stakes: ['0.20'],                                            mode: 'spin', customSeeds: true, seedCount: 10, betsPerSeed: 50 },
    { key: 'E', name: 'Edge cases / replay', total: 200,  stakes: ['0.20'],                                            mode: 'spin', customSeeds: false },
  ];

  var BETS_PER_EPOCH = 50;        // Duel platform-enforced epoch cap
  var BET_DELAY      = 1500;      // ms between spins (slot animations need time)
  var MAX_ERRORS     = 8;
  var DB_NAME        = 'groomers_capture';
  var GAME_SLUG      = 'groomers-van';
  var FEATURE_CODE   = 'bombs_bonus';   // from /api/v2/slots config
  var BALANCE_TYPE   = 105;             // confirmed from spin-1835724 request

  // ── State ────────────────────────────────────────────────────────────────
  var meta = {
    running: false, phaseIdx: 0, phaseStarted: false, phaseBets: 0, epochBets: 0,
    phaseBetCounts: {}, customSeedIdx: 0, customSeedBets: 0, lastSpinId: null,
    lastNextHash: null, activeServerSeedHashed: null, activeClientSeed: null,
    token: null, tokenAt: 0, errors: 0, finalRotationDone: false,
    // Buy/feature-trigger spin ids accumulated within the current epoch.
    // After rotation we call /verify on each so the response (with all
    // free-spin records) lands in the events log for save() to stitch.
    epochTriggerSpinIds: [],
  };
  var paused = false, betCount = 0, seedCount = 0;
  for (var i = 0; i < PHASES.length; i++) meta.phaseBetCounts[PHASES[i].key] = 0;

  // ── IndexedDB persistence ────────────────────────────────────────────────
  var db = null;
  function openDB() {
    return new Promise(function (resolve, reject) {
      // bumped to v2 to add the `events` raw-HTTP-log store
      var req = indexedDB.open(DB_NAME, 2);
      req.onupgradeneeded = function (e) {
        var d = e.target.result;
        if (!d.objectStoreNames.contains('bets'))   d.createObjectStore('bets',   { keyPath: 'spinId' });
        if (!d.objectStoreNames.contains('seeds'))  d.createObjectStore('seeds',  { autoIncrement: true });
        if (!d.objectStoreNames.contains('meta'))   d.createObjectStore('meta',   { keyPath: 'k' });
        if (!d.objectStoreNames.contains('events')) d.createObjectStore('events', { autoIncrement: true });
      };
      req.onsuccess = function (e) { db = e.target.result; resolve(); };
      req.onerror   = function (e) { reject(e.target.error); };
    });
  }
  function dbPut(store, value) {
    return new Promise(function (res, rej) {
      var tx = db.transaction(store, 'readwrite');
      var req = tx.objectStore(store).put(value);
      req.onsuccess = function () { res(); };
      req.onerror   = function (e) { rej(e.target.error); };
    });
  }
  function dbGetAll(store) {
    return new Promise(function (res, rej) {
      var tx = db.transaction(store, 'readonly');
      var req = tx.objectStore(store).getAll();
      req.onsuccess = function (e) { res(e.target.result); };
      req.onerror   = function (e) { rej(e.target.error); };
    });
  }
  function saveMeta() { return dbPut('meta', { k: 'state', v: meta, betCount: betCount, seedCount: seedCount }); }
  function loadMeta() {
    return new Promise(function (res) {
      var tx = db.transaction('meta', 'readonly');
      var req = tx.objectStore('meta').get('state');
      req.onsuccess = function (e) {
        var rec = e.target.result;
        if (rec) { Object.assign(meta, rec.v); betCount = rec.betCount || 0; seedCount = rec.seedCount || 0; }
        res();
      };
      req.onerror = function () { res(); };
    });
  }

  // ── Logging + panel ──────────────────────────────────────────────────────
  function log(msg)  { console.log('%c[groomers] ' + msg, 'color:#5c9eff'); updatePanel(); }
  function warn(msg) { console.warn('%c[groomers] ' + msg, 'color:#ffcc44'); updatePanel(); }
  function good(msg) { console.log('%c[groomers] ' + msg, 'color:#81c784'); updatePanel(); }
  function bad(msg)  { console.error('%c[groomers] ' + msg, 'color:#ff4444; font-weight:bold'); updatePanel(); }

  function buildPanel() {
    var old = document.getElementById('cap-panel-groomers'); if (old) old.remove();
    var d = document.createElement('div'); d.id = 'cap-panel-groomers';
    Object.assign(d.style, { position:'fixed', bottom:'16px', right:'16px', zIndex:'99999', background:'#0d1117', border:'1px solid #1e2d3d', borderRadius:'8px', padding:'12px 16px', fontFamily:'monospace', fontSize:'11px', color:'#b8cfe0', minWidth:'320px', boxShadow:'0 4px 24px rgba(0,0,0,.7)', cursor:'move', userSelect:'none' });
    var dragging = false, ox = 0, oy = 0;
    d.addEventListener('mousedown', function (e) { if (e.target.tagName === 'BUTTON') return; dragging = true; ox = e.clientX - d.offsetLeft; oy = e.clientY - d.offsetTop; });
    document.addEventListener('mousemove', function (e) { if (!dragging) return; d.style.left = (e.clientX - ox) + 'px'; d.style.top = (e.clientY - oy) + 'px'; d.style.right = 'auto'; d.style.bottom = 'auto'; });
    document.addEventListener('mouseup', function () { dragging = false; });

    var title = document.createElement('div'); title.textContent = 'GROOMERS VAN CAPTURE';
    Object.assign(title.style, { color:'#5c9eff', fontWeight:'700', fontSize:'13px' }); d.appendChild(title);
    var st = document.createElement('div'); st.id = 'cap-status-g'; Object.assign(st.style, { margin:'6px 0', color:'#4d6880', fontSize:'10px' }); d.appendChild(st);

    for (var pi = 0; pi < PHASES.length; pi++) {
      var ph = PHASES[pi];
      var row = document.createElement('div'); Object.assign(row.style, { display:'flex', alignItems:'center', gap:'6px', marginBottom:'3px' });
      var lbl = document.createElement('span'); lbl.textContent = ph.key + ' (' + ph.mode + ')';
      Object.assign(lbl.style, { width:'70px', color:'#4d6880', fontWeight:'700', fontSize:'10px' });
      var barOuter = document.createElement('div'); Object.assign(barOuter.style, { flex:'1', height:'8px', background:'#161e28', borderRadius:'4px', overflow:'hidden' });
      var fill = document.createElement('div'); fill.id = 'cap-bar-g-' + ph.key; Object.assign(fill.style, { height:'100%', width:'0%', background:'#2dff82', borderRadius:'4px', transition:'width .3s' }); barOuter.appendChild(fill);
      var ct = document.createElement('span'); ct.id = 'cap-ct-g-' + ph.key; ct.textContent = '0/' + ph.total; Object.assign(ct.style, { width:'60px', textAlign:'right', fontSize:'9px', color:'#4d6880' });
      row.appendChild(lbl); row.appendChild(barOuter); row.appendChild(ct); d.appendChild(row);
    }

    var seedLine = document.createElement('div'); seedLine.id = 'cap-seeds-g'; Object.assign(seedLine.style, { margin:'6px 0 4px', fontSize:'10px', color:'#4d6880' }); d.appendChild(seedLine);
    var btnRow = document.createElement('div'); Object.assign(btnRow.style, { display:'flex', gap:'4px', marginTop:'8px' });
    function mkBtn(text, color, fn) { var b = document.createElement('button'); b.textContent = text; Object.assign(b.style, { flex:'1', padding:'5px 0', background:'#161e28', border:'1px solid #1e2d3d', color: color, borderRadius:'3px', cursor:'pointer', fontFamily:'monospace', fontSize:'10px', fontWeight:'700' }); b.addEventListener('click', fn); return b; }
    btnRow.appendChild(mkBtn('GO',    '#2dff82', function () { pub.go(); }));
    btnRow.appendChild(mkBtn('PAUSE', '#ffcc44', function () { pub.pause(); }));
    btnRow.appendChild(mkBtn('SAVE',  '#33ccff', function () { pub.save(); }));
    d.appendChild(btnRow); document.body.appendChild(d);
  }

  function updatePanel() {
    for (var pi = 0; pi < PHASES.length; pi++) {
      var ph = PHASES[pi]; var n = meta.phaseBetCounts ? (meta.phaseBetCounts[ph.key] || 0) : 0;
      var bar = document.getElementById('cap-bar-g-' + ph.key); var ct = document.getElementById('cap-ct-g-' + ph.key);
      if (bar) { bar.style.width = Math.min(100, n / ph.total * 100) + '%'; bar.style.background = n >= ph.total ? '#33ccff' : '#2dff82'; }
      if (ct) ct.textContent = n + '/' + ph.total;
    }
    var st = document.getElementById('cap-status-g');
    if (st) { st.textContent = (paused ? 'PAUSED' : (meta.running ? 'RUNNING' : 'IDLE')) + ' | spins: ' + betCount + ' | seeds: ' + seedCount + (meta.errors > 0 ? ' | err:' + meta.errors : ''); st.style.color = meta.running && !paused ? '#2dff82' : '#4d6880'; }
    var sl = document.getElementById('cap-seeds-g');
    if (sl) sl.textContent = 'epoch: ' + (meta.epochBets || 0) + '/' + BETS_PER_EPOCH + ' | active hash: ' + (meta.activeServerSeedHashed ? meta.activeServerSeedHashed.slice(0, 16) : '?');
  }

  // ── HTTP API ─────────────────────────────────────────────────────────────
  var HEADERS = {
    'content-type': 'application/json', 'accept': 'application/json, text/plain, */*',
    'x-duel-device-identifier': localStorage.getItem('security:uuid') || '',
    'x-env-class': localStorage.getItem('env_class') || 'blue',
  };

  // Every HTTP call goes through api(). It records a raw event (request body,
  // status, full response with envelope) into the `events` store BEFORE
  // unwrapping. That preserves data we'd otherwise lose (success flags,
  // top-level meta, error messages, response headers we care about).
  function api(method, path, body) {
    var opts = { method: method, credentials: 'include', headers: HEADERS };
    if (body) opts.body = JSON.stringify(body);
    var startedAt = new Date().toISOString();
    return fetch(path, opts).then(function (res) {
      return res.text().then(function (text) {
        var parsed; try { parsed = JSON.parse(text); } catch (e) { parsed = { _raw: text }; }
        // Fire-and-forget raw event log. Don't block the call on this.
        // db is always open by the time api() is invoked (pub.go opens it first).
        try {
          dbPut('events', {
            ts: startedAt,
            method: method,
            path: path,
            requestBody: (body === undefined ? null : body),
            httpStatus: res.status,
            httpStatusText: res.statusText,
            responseBody: parsed,
            phaseAtCall: meta.phaseIdx !== undefined ? (PHASES[meta.phaseIdx] && PHASES[meta.phaseIdx].key) : null,
          }).catch(function () { /* swallow — event log best-effort */ });
        } catch (e) { /* same */ }
        if (!res.ok || (parsed && parsed.success === false)) {
          throw new Error(((parsed && parsed.message) || JSON.stringify(parsed).slice(0, 200)).slice(0, 200));
        }
        return (parsed && parsed.data) || parsed;
      });
    });
  }

  function refreshToken() {
    return api('POST', '/api/v2/user/security/token', { uuid: localStorage.getItem('security:uuid'), code: '0000', type: 'standard' })
      .then(function (r) { meta.token = r.token || r; meta.tokenAt = Date.now(); return meta.token; });
  }
  function ensureToken() { return (Date.now() - meta.tokenAt > 300000) ? refreshToken() : Promise.resolve(meta.token); }

  function getActiveSeed() { return api('GET', '/api/v2/client-seed'); }
  function getVerify(spinId) { return api('GET', '/api/v2/slots/spins/' + spinId + '/verify'); }
  function getTransaction(txId) { return api('GET', '/api/v2/user/transactions/' + txId); }

  // confirm-animation is required ONLY for free spins inside an active
  // bonus session (the buy gives N free spins, each one is a /spin call,
  // each /spin response carries an animation that must be acknowledged
  // before the next free spin or the rotation that closes the feature).
  // It is NOT used for regular base_game /spin and NOT used for /buy
  // itself — calling it there returns HTTP 400 'errors.generic'.
  //
  // CRITICAL TIMING: the server holds an animation lock for several seconds
  // after the /spin response. Calling confirm-animation too soon returns
  // HTTP 500 errors.generic. HAR analysis of the UI's auto-play of a
  // bonus session showed delays of 1.5–17s, with the longest delays on
  // high-multiplier hits and multi-tumble cascades.
  //
  // Adaptive backoff: try at 3s, then on 500 retry at 5s, 8s, 12s, 20s.
  // Catches quick no-win spins fast (3s); gives long high-multiplier spins
  // up to ~48s of total wait before giving up. Self-corrects regardless of
  // how long the individual animation actually is.
  function confirmAnimation(spinId) {
    // body is `{}` per HAR — match the slot UI exactly.
    return api('POST', '/api/v2/slots/spins/' + spinId + '/confirm-animation', {});
  }

  function confirmAnimationAdaptive(spinId) {
    var delays = [3000, 5000, 8000, 12000, 20000]; // sums to 48s ceiling
    function attempt(i) {
      if (i >= delays.length) {
        return Promise.reject(new Error('confirm-animation(' + spinId + ') gave up after ' + delays.length + ' attempts'));
      }
      return wait(delays[i]).then(function () {
        return confirmAnimation(spinId).catch(function (e) {
          var transient = /500|errors\.generic|something went wrong/i.test(e.message);
          if (transient) {
            warn('confirm-animation(' + spinId + ') 500 on attempt ' + (i + 1) + ' — retrying');
            return attempt(i + 1);
          }
          throw e;
        });
      });
    }
    return attempt(0);
  }

  function placeSpin(token, amount) {
    return api('POST', '/api/v2/slots/' + GAME_SLUG + '/spin',
      { amount: amount, balance_type: BALANCE_TYPE, security_token: token });
  }
  function placeBuy(token, amount) {
    return api('POST', '/api/v2/slots/' + GAME_SLUG + '/buy',
      { amount: amount, balance_type: BALANCE_TYPE, feature_code: FEATURE_CODE, security_token: token });
  }

  function generateClientSeed() {
    var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    var s = 'pf_'; for (var i = 0; i < 13; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  }
  function generateAuditSeed(idx) { return 'pfaudit_groomers_seed' + String(idx).padStart(2, '0'); }
  function rotateClientSeed(customSeed) {
    var clientSeed = customSeed || generateClientSeed();
    return ensureToken().then(function (token) {
      log('rotate: clientSeed=' + clientSeed.slice(0, 16) + '…');
      return api('POST', '/api/v2/client-seed/rotate', { client_seed: clientSeed, security_token: token });
    });
  }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // ── Pre-flight: detect / clear leftover state from other games ───────────
  // Account-global seed rotation is gated by any open game state (BJ hand,
  // Mines round, Beef/cross-road round). If we don't clear these first, the
  // first 4 phase-start rotations will fail with HTTP 400 and the smoke runs
  // on a stale seed. Strategy: detect blackjack (abort, the audit account
  // shouldn't auto-resolve a hand that may carry stake risk); auto-cashout
  // mines and beef (safe — exits at current state, no further loss).
  function clearStuckGames() {
    var report = { blackjack: null, mines: null, crossRoad: null, slots: null };
    return ensureToken().then(function (token) {
      // 1. Blackjack — detect-only.
      var bj = fetch('/api/v2/blackjack', { method: 'GET', credentials: 'include', headers: HEADERS })
        .then(function (r) { return r.json().then(function (j) { return { http: r.status, body: j }; }); })
        .then(function (r) {
          var data = r.body && r.body.data;
          if (r.body && r.body.success && data && data.id && (data.status === 1 || data.status === '1')) {
            report.blackjack = { open: true, betId: data.id, nonce: data.nonce };
            throw new Error('Open blackjack hand (bet ' + data.id + '). Resolve at https://duel.com/blackjack before re-running.');
          }
          report.blackjack = { open: false };
        });
      return bj;
    }).then(function () {
      // 2. Mines — auto-cashout.
      return ensureToken().then(function (token) {
        return api('GET', '/api/v2/mines/active').then(function (data) {
          var rid = data && data.round && data.round.id;
          if (!rid || (data.round.status === 2)) { report.mines = { open: false }; return; }
          report.mines = { open: true, roundId: rid, action: 'cashout' };
          warn('mines: open round ' + rid + ' — attempting cashout');
          return api('POST', '/api/v2/mines/cashout', { round_id: rid, security_token: token })
            .then(function () { good('mines: cashout ok'); })
            .catch(function () {
              // Fallback: reveal+cashout (some states need a reveal first).
              return api('POST', '/api/v2/mines/reveal', { position: 0, round_id: rid, security_token: token })
                .then(function () { return api('POST', '/api/v2/mines/cashout', { round_id: rid, security_token: token }); })
                .then(function () { good('mines: reveal+cashout ok'); })
                .catch(function (e) { throw new Error('mines clear failed: ' + e.message); });
            });
        }).catch(function (e) {
          // GET /mines/active 404 just means endpoint unavailable; not a blocker.
          if (/404|not.*found/i.test(e.message)) { report.mines = { open: false, reason: 'endpoint-404' }; return; }
          throw e;
        });
      });
    }).then(function () {
      // 3. Beef / cross-road — auto-cashout. Same pattern.
      return ensureToken().then(function (token) {
        return api('GET', '/api/v2/cross-road/active').then(function (data) {
          var rid = data && data.round && data.round.id;
          if (!rid || (data.round.status === 2)) { report.crossRoad = { open: false }; return; }
          report.crossRoad = { open: true, roundId: rid, action: 'cashout' };
          warn('cross-road: open round ' + rid + ' — attempting cashout');
          return api('POST', '/api/v2/cross-road/cashout', { round_id: rid, security_token: token })
            .then(function () { good('cross-road: cashout ok'); })
            .catch(function () {
              return api('POST', '/api/v2/cross-road/step', { round_id: rid, security_token: token })
                .then(function () { return api('POST', '/api/v2/cross-road/cashout', { round_id: rid, security_token: token }); })
                .then(function () { good('cross-road: step+cashout ok'); })
                .catch(function (e) { throw new Error('cross-road clear failed: ' + e.message); });
            });
        }).catch(function (e) {
          if (/404|not.*found/i.test(e.message)) { report.crossRoad = { open: false, reason: 'endpoint-404' }; return; }
          throw e;
        });
      });
    }).then(function () {
      // 4. Slots — detect any active groomers-van session. If a feature is
      // open from a prior session, drain it before the main loop touches
      // anything else: any /rotate or /spin would otherwise fail until the
      // feature is fully consumed. Drain by ack'ing the unconfirmed last
      // spin (if any) and looping /spin until remaining_spins=0.
      return api('GET', '/api/v2/slots/' + GAME_SLUG + '/active').then(function (data) {
        if (!data || !data.feature_id || !data.remaining_spins) {
          report.slots = { active: null };
          return;
        }
        report.slots = {
          active: { feature_id: data.feature_id, current_spin: data.current_spin, remaining_spins: data.remaining_spins, trigger_spin_id: data.trigger_data && data.trigger_data.spin_id },
          action: 'drain',
        };
        warn('slots: active feature ' + data.feature_id + ' (' + data.remaining_spins + ' free spins) — draining before phase A');
        // Synthesize a minimal trigger record for playOutBonus.
        var triggerRecord = {
          spinId: data.trigger_data && data.trigger_data.spin_id,
          phase: 'preflight-drain',
          requestedStake: data.trigger_bet_amount_coins || '0.20',
          response: { feature_status: { feature_id: data.feature_id, remaining_spins: data.remaining_spins, current_spin: data.current_spin } },
        };
        // First ack the last unconfirmed spin if there is one — that
        // releases the per-spin animation lock so /spin can advance.
        // Use the delayed version: even on a fresh page load the server
        // may still hold the animation lock from the prior session.
        var ackFirst = data.last_spin_id
          ? confirmAnimationAdaptive(data.last_spin_id).catch(function () { /* may already be ack'd */ })
          : Promise.resolve();
        return ackFirst.then(function () { return playOutBonus(triggerRecord); }).then(function () {
          good('slots: drained pre-existing feature');
        });
      }).catch(function (e) { report.slots = { active: null, reason: 'unavailable: ' + e.message }; });
    }).then(function () {
      log('pre-flight: ' + JSON.stringify(report));
      return report;
    });
  }

  // ── Bonus play-out: drain free-spins after a buy or feature trigger ──────
  // After a /buy that triggers a feature, the server queues N free spins.
  // The next /spin returns spin_type=bonus_game (next free spin in the
  // queue), not a new base_game. We loop /spin until feature_status reports
  // remaining_spins=0 OR the response is back to base_game. Each free spin
  // is recorded as its own bet entry (mode='free_spin') with a pointer to
  // the trigger spin so the verifier can reconstruct the feature session.
  function playOutBonus(triggerRecord) {
    var resp = triggerRecord && triggerRecord.response;
    var fs   = resp && resp.feature_status;
    if (!resp) return Promise.resolve();
    if (!fs || !fs.remaining_spins || fs.remaining_spins <= 0) {
      // No bonus or already done. (Buy with feature_triggered=false would still
      // hit this path, e.g., a buy that paid scatter only.)
      return Promise.resolve();
    }
    var triggerSpinId = triggerRecord.spinId;
    var stake         = triggerRecord.requestedStake;
    var phase         = triggerRecord.phase;
    var featureId     = (fs && fs.feature_id) || null;
    log('bonus: feature ' + featureId + ' active, ' + fs.remaining_spins + ' free spins to drain');

    function step() {
      return ensureToken().then(function (token) {
        return getActiveSeed().then(function (active) {
          var startedAt = new Date().toISOString();
          // /spin during a bonus session returns the next free spin
          // (spin_type=bonus_game) rather than a new base_game.
          return placeSpin(token, stake).then(function (spinResp) {
            var rec = {
              spinId: spinResp.spin_id,
              phase: phase,
              mode: 'free_spin',
              triggerSpinId: triggerSpinId,
              featureId: featureId,
              requestedStake: stake,
              startedAt: startedAt,
              activeAtSpin: active,
              response: spinResp,
              nonce: spinResp.nonce !== undefined ? spinResp.nonce : (active.nonce !== undefined && active.nonce !== null ? active.nonce : null),
            };
            // Acknowledge this free-spin animation before recording, so the
            // next /spin (next free spin or eventual base_game) isn't blocked.
            // Use the delayed-and-retry version — confirming too quickly
            // returns HTTP 500 errors.generic.
            var afterAck = (spinResp && spinResp.spin_id)
              ? confirmAnimationAdaptive(spinResp.spin_id)
              : Promise.resolve();
            return afterAck.then(function () { return dbPut('bets', rec); }).then(function () {
              betCount++;
              meta.lastSpinId = rec.spinId; // important: lastSpinId tracks free spins too, so verify(lastSpinId) post-rotation reveals the seed
              var newFs = spinResp && spinResp.feature_status;
              var rem   = newFs && newFs.remaining_spins;
              var pfSk  = (newFs && newFs.pf_skipped) || (spinResp && spinResp.pf_skipped) || false;
              log('  free-spin ' + (newFs && newFs.current_spin) + '/' + ((newFs && newFs.current_spin + rem) || '?') +
                  ' [type=' + spinResp.spin_type + '] won=' + (spinResp.total_win || '0') +
                  (pfSk ? ' [pf_skipped]' : ''));
              if (spinResp.spin_type === 'base_game' || rem === 0 || rem === undefined) {
                good('bonus: drained');
                return saveMeta();
              }
              return saveMeta().then(function () { return wait(BET_DELAY); }).then(step);
            });
          }).catch(function (e) {
            // 'Please wait for your current spin to finish' — server is still
            // animating the prior free-spin server-side. Back off and retry.
            if (/wait.*current.*spin/i.test(e.message)) {
              warn('bonus: spin in progress, backing off 3s');
              return wait(3000).then(step);
            }
            throw e;
          });
        });
      });
    }
    return step();
  }

  // ── Place one spin (or buy-bonus) ────────────────────────────────────────
  function placeBet(phase, token) {
    var ph = PHASES.find(function (p) { return p.key === phase; });
    var stakes = ph.stakes || [ph.stake];
    var stake = stakes[(meta.phaseBetCounts[ph.key] || 0) % stakes.length];

    // Snapshot the active commitment BEFORE the spin so we know which
    // server-seed-hash this nonce belongs to, regardless of when reveal lands.
    return getActiveSeed().then(function (active) {
      var fn = ph.mode === 'buy' ? placeBuy : placeSpin;
      var startedAt = new Date().toISOString();
      return fn(token, stake).then(function (resp) {
        var record = {
          spinId: resp.spin_id,
          phase: phase,
          mode: ph.mode,
          requestedStake: stake,
          startedAt: startedAt,
          activeAtSpin: active,                    // {clientSeed, serverSeedHashed, nextServerSeedHash, nonce}
          response: resp,                          // FULL response (view, rounds, multipliers, win info, edge_multiplier, etc.)
          // Guard against the truthiness trap: nonce=0 is legitimate (post-rotation)
          // but `0 || null` would mask it as null. Use ?? to fall through only on null/undef.
          nonce: resp.nonce !== undefined ? resp.nonce : (active.nonce !== undefined && active.nonce !== null ? active.nonce : null),
        };
        // NOTE: confirm-animation is NOT called for regular base_game /spin
        // or for /buy. It only applies to the free-spin sequence inside a
        // bonus session — handled in playOutBonus(). Calling it on a
        // base_game spin returns 400 'errors.generic' and breaks the run.
        return record;
      });
    });
  }

  // ── Phase rotation: reveal previous server seed + commit next one ────────
  function doRotation(phase, customSeed) {
    return ensureToken().then(function () {
      return getActiveSeed();
    }).then(function (preActive) {
      meta.preRotateActive = preActive;
      return rotateClientSeed(customSeed);
    }).then(function (rot) {
      var entry = {
        at: new Date().toISOString(), context: 'rotate-phase-' + phase, phase: phase,
        seed: { clientSeed: rot.client_seed, serverSeedHashed: rot.server_seed_hashed,
                nextServerSeedHash: rot.next_server_seed_hash, serverSeed: null },
        nonce: 0,
      };

      // Promotion check — the seed that was active before rotation should
      // become the previously committed `next_server_seed_hash`.
      var promoted = (meta.lastNextHash && rot.server_seed_hashed === meta.lastNextHash);
      if (promoted) good('promoted: ' + meta.lastNextHash.slice(0, 16) + ' → ' + rot.server_seed_hashed.slice(0, 16));
      else if (meta.lastNextHash) warn('PROMOTION MISMATCH! expected ' + meta.lastNextHash.slice(0, 16) + ' got ' + rot.server_seed_hashed.slice(0, 16));
      meta.lastNextHash = rot.next_server_seed_hash;
      meta.activeServerSeedHashed = rot.server_seed_hashed;
      meta.activeClientSeed = rot.client_seed;

      // After rotation the previously-active server seed is revealed.
      // /spins/{spinId}/verify also returns the full feature session if the
      // queried spin was a buy/trigger — including all free-spin
      // outcome_index, pf_skipped, tumbles. Calling /verify on every recent
      // bet (last bet + last buy/trigger) gives us complete reproduction
      // data with no extra round-trips needed during analysis.
      function attemptReveal() {
        if (!meta.lastSpinId) return Promise.resolve(null);
        // Pull buy/trigger spin ids from this rotation's epoch so /verify
        // returns the full feature session for each.
        var triggerIds = (meta.epochTriggerSpinIds || []).slice();
        if (meta.lastSpinId && triggerIds.indexOf(meta.lastSpinId) < 0) triggerIds.push(meta.lastSpinId);
        // We don't need to thread results — the events log records every
        // /verify response, so save() can stitch them. Just fire all.
        return triggerIds.reduce(function (p, id) {
          return p.then(function () { return getVerify(id).catch(function () { return null; }); });
        }, Promise.resolve()).then(function () {
          // Return the revealed server_seed for the last spin (best signal
          // for the 'promoted' check).
          return getVerify(meta.lastSpinId).then(function (v) {
            var s = (v && (v.server_seed || (v.data && v.data.server_seed))) || null;
            if (s) return s;
            return getTransaction(meta.lastSpinId).then(function (t) {
              return (t && (t.server_seed || (t.data && t.data.server_seed))) || null;
            });
          }).catch(function () { return null; });
        });
      }

      return attemptReveal().then(function (revealed) {
        entry.prevSpinSeedRevealed = revealed;
        entry.prevSpinId = meta.lastSpinId;
        if (revealed) good('revealed via verify(' + meta.lastSpinId + '): ' + revealed.slice(0, 16) + '…');
        else if (meta.lastSpinId) warn('reveal pending for spin ' + meta.lastSpinId);
        return dbPut('seeds', entry);
      });
    }).then(function () {
      seedCount++; meta.epochBets = 0; meta.errors = 0;
      meta.epochTriggerSpinIds = []; // reset for the new epoch
      return saveMeta();
    });
  }

  // ── Main loop ────────────────────────────────────────────────────────────
  function mainLoop() {
    if (paused || INSTANCE < 0) { meta.running = false; saveMeta(); log('stopped.'); return; }

    var phaseIdx = meta.phaseIdx || 0;
    if (phaseIdx >= PHASES.length) {
      // Final rotation reveals the very last spin's server seed.
      if (meta.lastSpinId && !meta.finalRotationDone) {
        meta.finalRotationDone = true;
        good('all phases complete — final rotation to reveal last seed…');
        doRotation('final').then(function () {
          meta.running = false; saveMeta(); good('ALL PHASES COMPLETE! Run groomers.save() to download.');
        }).catch(function (e) {
          bad('final rotation failed: ' + e.message); meta.running = false; saveMeta();
        });
        return;
      }
      meta.running = false; saveMeta(); good('ALL PHASES COMPLETE! Run groomers.save() to download.'); return;
    }

    var ph = PHASES[phaseIdx];
    var phaseDone = (meta.phaseBetCounts[ph.key] || 0) >= ph.total;
    if (phaseDone) { meta.phaseIdx++; meta.phaseBets = 0; meta.epochBets = 0; meta.phaseStarted = false; meta.customSeedIdx = 0; meta.customSeedBets = 0; saveMeta(); return mainLoop(); }

    // Phase start: rotate seed (custom for D, generated for others).
    if (!meta.phaseStarted) {
      meta.phaseStarted = true;
      var customSeed = ph.customSeeds ? generateAuditSeed(meta.customSeedIdx || 0) : null;
      doRotation(ph.key, customSeed).then(function () { saveMeta(); return mainLoop(); })
        .catch(function (e) { bad('rotation error: ' + e.message); meta.errors++; saveMeta(); wait(2000).then(mainLoop); });
      return;
    }

    // Custom-seed sub-rotation within Phase D every betsPerSeed spins.
    if (ph.customSeeds && meta.customSeedBets >= ph.betsPerSeed) {
      if ((meta.customSeedIdx || 0) + 1 < ph.seedCount) {
        meta.customSeedIdx = (meta.customSeedIdx || 0) + 1;
        meta.customSeedBets = 0;
        var nextSeed = generateAuditSeed(meta.customSeedIdx);
        doRotation(ph.key, nextSeed).then(function () { saveMeta(); return mainLoop(); })
          .catch(function (e) { bad('rotation error: ' + e.message); meta.errors++; saveMeta(); wait(2000).then(mainLoop); });
        return;
      } else {
        // No more custom seeds — keep using the current one. Reset the
        // counter so we don't keep entering this block.
        meta.customSeedBets = 0;
      }
    }

    // Epoch rotation every BETS_PER_EPOCH spins (matches platform cap).
    if (meta.epochBets >= BETS_PER_EPOCH) {
      var customSeed2 = ph.customSeeds ? generateAuditSeed(meta.customSeedIdx) : null;
      doRotation(ph.key, customSeed2).then(function () { saveMeta(); return mainLoop(); })
        .catch(function (e) { bad('rotation error: ' + e.message); meta.errors++; saveMeta(); wait(2000).then(mainLoop); });
      return;
    }

    // Place one bet.
    ensureToken().then(function (token) {
      return placeBet(ph.key, token);
    }).then(function (record) {
      return dbPut('bets', record).then(function () {
        betCount++;
        meta.phaseBets++;
        meta.epochBets++;
        meta.customSeedBets++;
        meta.phaseBetCounts[ph.key]++;
        meta.lastSpinId = record.spinId;
        meta.errors = 0;

        var totalWin = (record.response && record.response.total_win) || '0';
        var trig = record.response && record.response.feature_triggered ? ' FEATURE!' : '';
        log(ph.key + ' #' + meta.phaseBetCounts[ph.key] + '/' + ph.total +
            ' [' + record.mode + '] stake=' + record.requestedStake +
            ' nonce=' + record.nonce +
            ' won=' + totalWin + trig);
        return saveMeta().then(function () { return record; });
      });
    }).then(function (record) {
      // If this bet triggered a feature (any buy that paid scatters, or any
      // base spin that landed 3+ scatters), drain the free spins server-side
      // before returning to the main loop. Otherwise the next /spin will
      // return spin_type=bonus_game (a free-spin continuation) instead of
      // the next scheduled bet.
      var fs = record && record.response && record.response.feature_status;
      if (fs && fs.remaining_spins && fs.remaining_spins > 0) {
        // Record this trigger spin so the next rotation calls /verify on it
        // and captures the full feature session into the events log.
        meta.epochTriggerSpinIds = (meta.epochTriggerSpinIds || []).concat([record.spinId]);
        return saveMeta().then(function () { return wait(BET_DELAY); }).then(function () { return playOutBonus(record); });
      }
    }).then(function () {
      return wait(BET_DELAY);
    }).then(function () {
      mainLoop();
    }).catch(function (e) {
      bad('spin error: ' + e.message);
      meta.errors++;
      if (meta.errors >= MAX_ERRORS) { bad('MAX ERRORS — pausing'); paused = true; }
      saveMeta();
      wait(3000).then(mainLoop);
    });
  }

  });
console.log('[groomers] reference record loaded — see data/ for the captured dataset');
