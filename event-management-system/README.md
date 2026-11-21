# EventSphere — Event Management System (Vercel + Supabase)

Static HTML/CSS/JS frontend. Supabase provides authentication, the PostgreSQL
database and all security rules (Row Level Security). No PHP, no server.

## 1. Supabase setup (5 minutes)
1. Create a project at supabase.com.
2. **SQL Editor → New query →** paste all of `supabase/schema.sql` → Run.
   (Safe to re-run.)
3. *(Optional demo data)* Register once in the app, make yourself admin (step 4),
   then run `supabase/seed.sql`.
4. **First admin:** after registering in the app, run in the SQL Editor:
   `update public.profiles set role_id = 1 where email = 'you@example.com';`
   Afterwards use the **Users** page to promote others to organizer/admin.
5. **Project Settings → API:** copy the *Project URL* and the *anon public* key.
6. *(Recommended for testing)* **Authentication → Providers → Email:** turn off
   "Confirm email" so new accounts can sign in immediately. Leave it on in production.

## 2. Configure the app
Edit `config.js` and paste the Project URL + anon key. The anon key is meant to
be public. **Never** put the `service_role` key anywhere in this project.

## 3. Run locally
`npx serve .`  (or any static server) → open the printed URL.
Do not open `index.html` via `file://`.

## 4. Deploy to Vercel
- Push this folder to GitHub → Vercel → *Add New Project* → import it.
- Framework preset: **Other**. No build command, no output directory.
- Deploy. (Or `npx vercel --prod` from this folder.)
- In Supabase **Authentication → URL Configuration**, set *Site URL* to your
  Vercel URL (needed for email-confirmation links).

## Roles
| Role | Can do |
|---|---|
| participant | browse published events, book, cancel own bookings |
| organizer | + create/edit own events, add venues, confirm bookings on own events |
| admin | everything, incl. users, payments, reports |

## Payments
There is no payment gateway. A booking for a paid event starts as **pending**;
an admin/organizer marks it **confirmed** (this completes the payment record).
Free events are confirmed automatically. Cancelling releases the seats and
marks the payment refunded/failed.
