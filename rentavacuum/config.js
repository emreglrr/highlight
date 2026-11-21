// Public config. The key below is Supabase's *publishable* (anon) key — it's meant to be public.
// All data access goes through locked-down database functions; admin actions need a login token.
window.RAV = {
  SUPABASE_URL: "https://cvqlrxsuyalcawsagukj.supabase.co",
  SUPABASE_KEY: "sb_publishable_2copM9J6eK4u5IUYF7c7gA_5sby3bmi",
  // Shown to renters after booking. Edit freely (e.g. "Tikkie link in the PURE group chat").
  PAYMENT_NOTE: "Send the money via Tikkie or bank transfer. As soon as it's in, your day is confirmed.",
};

window.rpc = async function rpc(fn, args = {}) {
  const res = await fetch(`${RAV.SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      apikey: RAV.SUPABASE_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const err = new Error((data && data.message) || "Something went wrong");
    err.code = data && data.code;
    throw err;
  }
  return data;
};

// ---- time helpers (all slots live in the configured timezone) ----
window.tzOffsetMs = function (date, tz) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(date).map((x) => [x.type, x.value])
  );
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUTC - date.getTime();
};
window.zonedTime = function (dateStr, hour, tz) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d, hour);
  const off = tzOffsetMs(new Date(guess), tz);
  return new Date(guess - off);
};
window.addDays = function (dateStr, n) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
};
window.buildDays = function (cfg) {
  const days = [];
  for (let d = cfg.start_date; d <= cfg.end_date; d = addDays(d, 1)) days.push(d);
  return days;
};
window.buildSlots = function (cfg, day) {
  const out = [];
  for (let h = cfg.first_hour; h + cfg.slot_hours <= cfg.last_hour; h += cfg.slot_hours) {
    out.push({ day, hour: h, end: h + cfg.slot_hours, start: zonedTime(day, h, cfg.tz) });
  }
  return out;
};
window.fmtDay = function (dateStr, opts) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", ...opts }).format(new Date(Date.UTC(y, m - 1, d)));
};
window.pad = (h) => String(h).padStart(2, "0") + ":00";
window.euro = (n) => "€" + Number(n).toLocaleString("en-GB", { maximumFractionDigits: 2 });
window.esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
