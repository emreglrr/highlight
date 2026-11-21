(() => {
  const $ = (s) => document.querySelector(s);
  const app = $("#app");
  const KEY = "rav.admin";
  let token = null;
  try { token = localStorage.getItem(KEY); } catch {}
  let cfg = null, rows = [], tab = "pending";

  function toast(msg, bad) {
    const t = $("#toast");
    t.textContent = msg;
    t.className = "toast show" + (bad ? " bad" : "");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (t.className = "toast"), 3200);
  }
  const setToken = (t) => { token = t; try { t ? localStorage.setItem(KEY, t) : localStorage.removeItem(KEY); } catch {} };

  async function call(fn, args) {
    try { return await rpc(fn, { p_token: token, ...args }); }
    catch (e) { if (e.code === "28000") { setToken(null); showLogin("Session expired, log in again."); } throw e; }
  }

  // ---------------- login ----------------
  function showLogin(msg) {
    app.innerHTML = `
      <div class="login"><div class="card">
        <div class="lock"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffd23f" stroke-width="2.4" stroke-linecap="round"><rect x="4" y="11" width="16" height="10" rx="3"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg></div>
        <h1>Owner login</h1>
        <p class="sub" style="color:var(--ink-2);margin:0 0 20px">Manage bookings for the vacuum.</p>
        <form id="lf">
          <div class="err ${msg ? "show" : ""}" id="lerr">${esc(msg || "")}</div>
          <div class="field"><label for="em">Email</label><input type="email" id="em" required autocomplete="username" /></div>
          <div class="field"><label for="pw">Password</label><input type="password" id="pw" required autocomplete="current-password" /></div>
          <button class="btn dark" style="width:100%;margin-top:6px" id="lb">Log in</button>
        </form>
        <p style="text-align:center;margin:18px 0 0;font-size:13px"><a href="./" style="color:var(--ink-3)">← back to booking page</a></p>
      </div></div>`;
    $("#em").focus();
    $("#lf").onsubmit = async (e) => {
      e.preventDefault();
      const b = $("#lb"), err = $("#lerr");
      b.disabled = true; b.textContent = "Checking…"; err.classList.remove("show");
      try {
        const t = await rpc("vac_admin_login", { p_email: $("#em").value, p_password: $("#pw").value });
        if (!t) throw new Error("Wrong email or password.");
        setToken(t);
        dashboard();
      } catch (ex) {
        err.textContent = ex.message; err.classList.add("show");
        b.disabled = false; b.textContent = "Log in";
        $("#pw").value = ""; $("#pw").focus();
      }
    };
  }

  // ---------------- dashboard ----------------
  async function dashboard() {
    app.innerHTML = `<div class="wrap" style="padding-top:40px"><div class="skeleton" style="height:120px"></div></div>`;
    try {
      cfg = await rpc("vac_config");
      await load();
    } catch (e) { if (token) toast(e.message, true); return; }
    setInterval(() => load().catch(() => {}), 30000);
  }

  async function load() {
    rows = await call("vac_admin_bookings", {});
    render();
  }

  function groups() {
    const m = new Map();
    for (const r of rows) {
      if (r.status === "blocked") continue;
      if (!m.has(r.group_id)) m.set(r.group_id, { ...r, slots: [] });
      m.get(r.group_id).slots.push(r.slot_start);
    }
    return [...m.values()].sort((a, b) => new Date(a.slots[0]) - new Date(b.slots[0]));
  }

  const fmt = (iso, o) => new Intl.DateTimeFormat("en-GB", { timeZone: cfg.tz, ...o }).format(new Date(iso));
  const slotLabel = (iso) => {
    const end = new Date(new Date(iso).getTime() + cfg.slot_hours * 3600e3).toISOString();
    return `${fmt(iso, { weekday: "short", day: "numeric", month: "short" })} · ${fmt(iso, { hour: "2-digit", minute: "2-digit" })}–${fmt(end, { hour: "2-digit", minute: "2-digit" })}`;
  };
  const waLink = (p) => {
    let d = p.replace(/[^\d+]/g, "");
    if (d.startsWith("+")) d = d.slice(1); else if (d.startsWith("00")) d = d.slice(2); else if (d.startsWith("0")) d = "31" + d.slice(1);
    return "https://wa.me/" + d;
  };

  function render() {
    const g = groups();
    const by = (s) => g.filter((x) => x.status === s);
    const pend = by("pending"), conf = by("confirmed"), canc = by("cancelled");
    const money = (arr) => arr.reduce((n, x) => n + x.slots.length * cfg.price_per_slot, 0);
    const list = tab === "all" ? g : by(tab);
    const totalSlots = buildDays(cfg).length * buildSlots(cfg, cfg.start_date).length;
    const used = rows.filter((r) => r.status === "pending" || r.status === "confirmed").length;

    app.innerHTML = `
      <div class="wrap">
        <header class="top">
          <a class="brand" href="./"><span class="brand-mark"><svg viewBox="0 0 24 24" fill="none"><rect x="6" y="8" width="12" height="12" rx="3" fill="#ffd23f"/><rect x="4" y="4" width="16" height="5" rx="2" fill="#fff"/></svg></span>Owner</a>
          <div style="display:flex;gap:8px">
            <button class="btn ghost sm" id="rf">↻ Refresh</button>
            <button class="btn ghost sm" id="lo">Log out</button>
          </div>
        </header>

        <div class="stats">
          <div class="card stat hl"><span>To confirm</span><b>${pend.length}</b></div>
          <div class="card stat"><span>Paid</span><b>${euro(money(conf))}</b></div>
          <div class="card stat"><span>Outstanding</span><b>${euro(money(pend))}</b></div>
          <div class="card stat"><span>Slots booked</span><b>${used}<small style="font-size:16px;color:var(--ink-3)">/${totalSlots}</small></b></div>
        </div>

        <section class="card panel">
          <div class="panel-head">
            <h2>Bookings</h2>
            <div class="tabs">
              ${[["pending", "To confirm", pend.length], ["confirmed", "Confirmed", conf.length], ["cancelled", "Cancelled", canc.length], ["all", "All", g.length]]
                .map(([k, l, n]) => `<button class="tab ${tab === k ? "on" : ""}" data-tab="${k}">${l}<span class="n">${n}</span></button>`).join("")}
            </div>
          </div>
          <div id="list">
            ${list.length ? list.map(card).join("") : `<div class="empty">${tab === "pending" ? "Nothing to confirm. ☕" : "Nothing here yet."}</div>`}
          </div>
        </section>

        <section class="card panel" style="margin-bottom:40px">
          <div class="panel-head">
            <h2>Week overview</h2>
            <span style="font-size:13px;color:var(--ink-3)">Tap a free slot to block it (e.g. when you need the vacuum yourself)</span>
          </div>
          <div class="scrollx">${grid()}</div>
        </section>
      </div>`;

    $("#rf").onclick = () => load().then(() => toast("Up to date"));
    $("#lo").onclick = async () => { try { await rpc("vac_admin_logout", { p_token: token }); } catch {} setToken(null); showLogin(); };
    app.querySelectorAll(".tab").forEach((b) => (b.onclick = () => { tab = b.dataset.tab; render(); }));
    app.querySelectorAll("[data-act]").forEach((b) => (b.onclick = () => act(b.dataset.g, b.dataset.act, b)));
    app.querySelectorAll(".cell[data-iso]").forEach((b) => (b.onclick = () => cellClick(b.dataset.iso, b.dataset.st)));
  }

  function card(x) {
    const amt = euro(x.slots.length * cfg.price_per_slot);
    const btn = {
      pending: `<button class="btn ok sm" data-act="confirmed" data-g="${x.group_id}">✓ Paid — confirm</button><button class="btn bad sm" data-act="cancelled" data-g="${x.group_id}">Cancel</button>`,
      confirmed: `<button class="btn ghost sm" data-act="pending" data-g="${x.group_id}">Mark unpaid</button><button class="btn bad sm" data-act="cancelled" data-g="${x.group_id}">Cancel</button>`,
      cancelled: `<button class="btn ghost sm" data-act="pending" data-g="${x.group_id}">Restore</button>`,
    }[x.status];
    const badge = { pending: "⏳ Awaiting payment", confirmed: "✓ Paid", cancelled: "Cancelled" }[x.status];
    return `<div class="bk ${x.status}">
      <div>
        <div class="who">${esc(x.name)} <span class="badge ${x.status}" style="vertical-align:2px;margin-left:6px">${badge}</span></div>
        <div class="meta">
          <span>🏠 Apt ${esc(x.apartment)}</span>
          <a href="tel:${esc(x.phone)}">📞 ${esc(x.phone)}</a>
          <a href="${waLink(x.phone)}" target="_blank" rel="noopener">💬 WhatsApp</a>
          <span style="color:var(--ink-3)">booked ${fmt(x.created_at, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</span>
        </div>
        <div class="when">${x.slots.map((s) => `<span class="chip">${slotLabel(s)}</span>`).join("")}</div>
        ${x.note ? `<div class="notep">“${esc(x.note)}”</div>` : ""}
      </div>
      <div class="right"><div class="amt">${amt}</div><div class="btns">${btn}</div></div>
    </div>`;
  }

  function grid() {
    const days = buildDays(cfg);
    const map = new Map();
    for (const r of rows) if (r.status !== "cancelled") map.set(new Date(r.slot_start).toISOString(), r);
    const now = new Date();
    let h = `<div class="grid"><div></div>${days.map((d) => `<div class="h">${fmtDay(d, { weekday: "short" })}<small>${fmtDay(d, { day: "numeric", month: "short" })}</small></div>`).join("")}`;
    const hours = buildSlots(cfg, days[0]).map((s) => s.hour);
    for (const hr of hours) {
      h += `<div class="tm">${pad(hr)}</div>`;
      for (const d of days) {
        const iso = zonedTime(d, hr, cfg.tz).toISOString();
        const r = map.get(iso);
        const past = new Date(iso) <= now ? " past" : "";
        if (!r) h += `<button class="cell${past}" data-iso="${iso}" data-st="free"><span style="color:var(--ink-3)">free</span></button>`;
        else if (r.status === "blocked") h += `<button class="cell blocked${past}" data-iso="${iso}" data-st="blocked"><b>Blocked</b>tap to free</button>`;
        else h += `<button class="cell ${r.status}${past}" data-iso="${iso}" data-st="${r.status}" title="${esc(r.name)} · ${esc(r.apartment)}"><b>${esc(r.name)}</b>${esc(r.apartment)}</button>`;
      }
    }
    return h + `</div>`;
  }

  async function act(g, status, b) {
    b.disabled = true;
    try {
      await call("vac_admin_set_status", { p_group: g, p_status: status });
      toast({ confirmed: "Confirmed ✓", cancelled: "Cancelled — slots are free again", pending: "Moved back to awaiting payment" }[status]);
      await load();
    } catch (e) { toast(e.message, true); b.disabled = false; }
  }

  async function cellClick(iso, st) {
    if (st === "free" || st === "blocked") {
      try {
        await call("vac_admin_block", { p_slot: iso, p_block: st === "free" });
        toast(st === "free" ? "Slot blocked" : "Slot freed");
        await load();
      } catch (e) { toast(e.message, true); }
    } else {
      tab = st === "confirmed" ? "confirmed" : "pending";
      render();
      document.querySelector("#list").scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  token ? dashboard() : showLogin();
})();
