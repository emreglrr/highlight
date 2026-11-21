(() => {
  const $ = (s) => document.querySelector(s);
  const MAX = 4;
  const LS = "rav.mine";

  let cfg = null;
  let days = [];
  let taken = new Map(); // iso -> status
  let selected = new Map(); // iso -> slot

  const loadMine = () => { try { return JSON.parse(localStorage.getItem(LS) || "[]"); } catch { return []; } };
  const saveMine = (v) => { try { localStorage.setItem(LS, JSON.stringify(v)); } catch {} };

  function toast(msg, bad) {
    const t = $("#toast");
    t.textContent = msg;
    t.className = "toast show" + (bad ? " bad" : "");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (t.className = "toast" + (bad ? " bad" : "")), 3800);
  }

  async function init() {
    try {
      cfg = await rpc("vac_config");
      days = buildDays(cfg);
      $("#f-price").textContent = euro(cfg.price_per_slot);
      $("#f-dates").textContent =
        fmtDay(cfg.start_date, { day: "numeric", month: "short" }) + " – " + fmtDay(cfg.end_date, { day: "numeric", month: "short" });
      $("#f-hours").textContent = pad(cfg.first_hour);
      await refresh();
      renderMine();
      setInterval(refresh, 30000);
    } catch (e) {
      $("#slots").innerHTML = `<div class="note" style="grid-column:1/-1">Couldn't load the calendar. Please refresh in a moment.</div>`;
    }
  }

  async function refresh() {
    const rows = await rpc("vac_slots");
    taken = new Map(rows.map((r) => [new Date(r.slot_start).toISOString(), r.status]));
    // drop selections that got taken meanwhile
    for (const iso of [...selected.keys()]) if (taken.has(iso)) selected.delete(iso);
    render();
  }

  function mineSet() {
    const s = new Set();
    loadMine().forEach((b) => b.slots.forEach((x) => s.add(new Date(x).toISOString())));
    return s;
  }

  const fmtAt = (d, o) => new Intl.DateTimeFormat("en-GB", { timeZone: cfg.tz, ...o }).format(d);

  function render() {
    const now = new Date();
    const mine = mineSet();
    // pad so the grid lines up Mon..Sun on desktop
    const lead = (new Date(cfg.start_date + "T00:00:00Z").getUTCDay() + 6) % 7;
    $("#slots").innerHTML = '<div class="pad"></div>'.repeat(lead) + days
      .flatMap((d) => buildSlots(cfg, d))
      .map((s) => {
        const iso = s.start.toISOString();
        const st = taken.get(iso);
        const past = s.start <= now;
        const isSel = selected.has(iso);
        const back = new Date(s.start.getTime() + cfg.slot_hours * 3600e3);
        let cls = "", label = euro(cfg.price_per_slot), dis = false;
        if (past) { cls = "past"; label = "Passed"; dis = true; }
        else if (st === "confirmed") { cls = "confirmed"; label = "Booked"; dis = true; }
        else if (st === "pending") { cls = "pending"; label = "Reserved"; dis = true; }
        else if (isSel) { cls = "sel"; label = "Selected"; }
        if (mine.has(iso)) { cls += " mine"; if (st) label = st === "confirmed" ? "Yours ✓" : "Yours · reserved"; }
        return `<button class="slot dayslot ${cls}" data-iso="${iso}" ${dis ? "disabled" : ""}>
          <div class="dw">${fmtDay(s.day, { weekday: "long" })}</div>
          <div class="t">${fmtDay(s.day, { day: "numeric", month: "short" })}</div>
          <div class="range">${fmtAt(s.start, { hour: "2-digit", minute: "2-digit" })} → ${fmtAt(back, { weekday: "short", hour: "2-digit", minute: "2-digit" })}</div>
          <div class="s"><span>${label}</span></div>
        </button>`;
      })
      .join("");

    const n = selected.size;
    $("#cart").classList.toggle("show", n > 0);
    $("#cart-count").textContent = `${n} day${n === 1 ? "" : "s"}`;
    $("#cart-total").textContent = euro(n * cfg.price_per_slot);
  }

  $("#slots").addEventListener("click", (e) => {
    const b = e.target.closest(".slot");
    if (!b || b.disabled) return;
    const iso = b.dataset.iso;
    if (selected.has(iso)) selected.delete(iso);
    else {
      if (selected.size >= MAX) return toast(`Max ${MAX} days per booking — leave some for the neighbours 😉`, true);
      selected.set(iso, true);
    }
    render();
  });

  $("#cart-clear").addEventListener("click", () => { selected.clear(); render(); });
  $("#cart-go").addEventListener("click", openForm);

  const modal = $("#modal");
  const sheet = $("#sheet");
  const close = () => modal.classList.remove("show");
  modal.addEventListener("click", (e) => { if (e.target === modal) close(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });

  function slotLabel(iso) {
    const d = new Date(iso);
    const f = (o) => new Intl.DateTimeFormat("en-GB", { timeZone: cfg.tz, ...o }).format(d);
    const end = new Date(d.getTime() + cfg.slot_hours * 3600e3);
    return `${f({ weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} → ${new Intl.DateTimeFormat("en-GB", { timeZone: cfg.tz, weekday: "short", hour: "2-digit", minute: "2-digit" }).format(end)}`;
  }

  function openForm() {
    const isos = [...selected.keys()].sort();
    const last = (() => { try { return JSON.parse(localStorage.getItem("rav.me") || "{}"); } catch { return {}; } })();
    sheet.innerHTML = `
      <h2 id="m-title">Almost yours</h2>
      <p class="sub">Tell us who you are so the owner knows who to hand the vacuum to.</p>
      <div class="chips">${isos.map((i) => `<span class="chip">${slotLabel(i)}</span>`).join("")}</div>
      <form id="f" autocomplete="on">
        <div class="err" id="ferr"></div>
        <div class="field"><label for="name">Your name</label><input type="text" id="name" name="name" required maxlength="80" value="${esc(last.name)}" autocomplete="name" /></div>
        <div class="row2">
          <div class="field"><label for="apt">Apartment nr.</label><input type="text" id="apt" name="apt" required maxlength="20" value="${esc(last.apt)}" placeholder="e.g. 4.12" /></div>
          <div class="field"><label for="phone">Phone / WhatsApp</label><input type="tel" id="phone" name="phone" required minlength="4" maxlength="30" value="${esc(last.phone)}" autocomplete="tel" /></div>
        </div>
        <div class="field"><label for="note">Note <span style="font-weight:400;color:var(--ink-3)">(optional)</span></label><textarea id="note" maxlength="300" placeholder="What are you cleaning? Pick-up wishes?"></textarea></div>
        <div class="total"><span>${isos.length} day${isos.length > 1 ? "s" : ""} × ${euro(cfg.price_per_slot)}</span><b>${euro(isos.length * cfg.price_per_slot)}</b></div>
        <div class="actions">
          <button type="button" class="btn ghost" id="fcancel">Back</button>
          <button type="submit" class="btn dark" id="fsubmit">Reserve</button>
        </div>
      </form>`;
    modal.classList.add("show");
    setTimeout(() => $("#name").focus(), 50);
    $("#fcancel").onclick = close;
    $("#f").onsubmit = async (e) => {
      e.preventDefault();
      const btn = $("#fsubmit");
      const name = $("#name").value.trim(), apt = $("#apt").value.trim(), phone = $("#phone").value.trim();
      btn.disabled = true; btn.textContent = "Reserving…";
      try {
        const r = await rpc("vac_book", { p_slots: isos, p_name: name, p_apartment: apt, p_phone: phone, p_note: $("#note").value });
        try { localStorage.setItem("rav.me", JSON.stringify({ name, apt, phone })); } catch {}
        const mine = loadMine();
        mine.push({ group_id: r.group_id, slots: isos, total: r.total, at: Date.now() });
        saveMine(mine);
        selected.clear();
        success(r, isos);
        refresh();
        renderMine();
      } catch (err) {
        const el = $("#ferr");
        el.textContent = err.message;
        el.classList.add("show");
        btn.disabled = false; btn.textContent = "Reserve";
        refresh();
      }
    };
  }

  function success(r, isos) {
    sheet.innerHTML = `
      <div class="success">
        <div class="big"><svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#2b2300" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7"/></svg></div>
        <h2 id="m-title">Reserved!</h2>
        <p class="sub">Your ${isos.length > 1 ? "days are" : "day is"} held for you. Pick up at ${pad(cfg.first_hour)}.</p>
      </div>
      <div class="pay">
        <div style="font-size:13px;color:var(--ink-3);text-transform:uppercase;letter-spacing:.06em;font-weight:600">Amount to pay</div>
        <b>${euro(r.total)}</b>
        <div style="color:var(--ink-2)">${esc(RAV.PAYMENT_NOTE)}</div>
      </div>
      <div class="chips">${isos.map((i) => `<span class="chip">${slotLabel(i)}</span>`).join("")}</div>
      <div class="actions"><button class="btn primary" id="done" style="width:100%">Got it</button></div>`;
    $("#done").onclick = close;
  }

  async function renderMine() {
    const mine = loadMine();
    const box = $("#mine");
    if (!mine.length) { box.hidden = true; return; }
    let rows = [];
    try {
      rows = await Promise.all(mine.map(async (b) => {
        const st = await rpc("vac_booking_status", { p_group: b.group_id });
        return { ...b, statuses: st || [] };
      }));
    } catch { return; }
    // forget bookings that are fully in the past for > 1 day
    const keep = rows.filter((b) => b.slots.some((s) => new Date(s).getTime() > Date.now() - 864e5));
    if (keep.length !== mine.length) saveMine(keep.map(({ statuses, ...b }) => b));
    if (!keep.length) { box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML = `<h3>Your bookings</h3>` + keep.map((b) => {
      const s = b.statuses.length ? b.statuses[0].status : "cancelled";
      const lab = { pending: "Reserved", confirmed: "✓ Confirmed", cancelled: "Cancelled" }[s] || s;
      return `<div class="mine-row">
        <div><div style="font-weight:600">${b.slots.map(slotLabel).join("<br>")}</div>
        <div style="font-size:13px;color:var(--ink-3)">${euro(b.total)}</div></div>
        <span class="badge ${s}">${lab}</span>
      </div>`;
    }).join("");
  }

  init();
})();
