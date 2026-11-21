# Rent a Vacuum 🧹

Tiny booking site for renting the industrial vacuum to PURE residents.

- `index.html` – residents pick 2-hour slots and reserve them (pay outside the app via Tikkie / bank).
- `admin.html` – owner login; confirm bookings once paid, cancel, block slots.
- Backend: Supabase (`supabase/schema.sql`). The browser only calls `vac_*` database functions;
  the tables themselves are not reachable with the public key. Admin password is bcrypt-hashed in the DB,
  sessions are random tokens (7 days), 5 wrong logins → 15 min lockout.

Change dates / hours / price: `update rentavacuum.settings set ...` in the Supabase SQL editor.
Change the payment text: `PAYMENT_NOTE` in `config.js`.

Deploy: `vercel deploy --prod` from this folder (static site, no build step).
