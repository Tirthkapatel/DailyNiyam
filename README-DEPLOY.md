# Daily Niyam — Deploy Guide (simple steps)

Daily Niyam (દૈનિક નિયમ) — a daily niyam reporting app. One repo contains both
parts:

- `api/index.js` — the server (accounts, reports, groups, admin). It runs on
  Vercel as a serverless function at `/api`.
- `client/` — the web app (React + Vite). `npm run build` makes static files
  in `dist/`, served on the **same link** as the API.
- Data lives in a **Turso** database (libSQL) — on the server, tied to each
  user's account. Nothing important is stored only on the phone, so clearing
  app data, changing phones, or reinstalling loses nothing: just log in again.

## Step 1 — Put the code on GitHub

Create a **new GitHub repository** (for example `daily-niyam`) and push this
whole folder to it.

## Step 2 — Create the Turso database

1. Go to https://turso.tech and sign up (free plan, no card needed).
2. Create a database named **`daily-niyam`**.
3. Open the database and copy its **Database URL** (starts with `libsql://`).
4. Create an **Auth Token** for the database and copy it too.

## Step 3 — Import the project on Vercel

1. Go to https://vercel.com → **Add New → Project** → import your GitHub repo.
2. Framework preset: **Other**. Build command: `npm run build`
   (already set in `vercel.json`). No other settings need changing.

## Step 4 — Add the 3 environment variables

In Vercel: **Project → Settings → Environment Variables**, add exactly these:

| Name | Value |
| --- | --- |
| `TURSO_DATABASE_URL` | the Database URL from Step 2 |
| `TURSO_AUTH_TOKEN` | the Auth Token from Step 2 |
| `SESSION_SECRET` | any long random string (30+ characters) — invent one and keep it secret |

## Step 5 — Redeploy

**Deployments → ⋯ → Redeploy** (needed once after adding the variables).
Open the Vercel link — the app and login work on the same link.

## Step 6 — First signup becomes the admin 👑

- The **very first account** that signs up on the new site automatically
  becomes the **admin** (sees the extra **Admin** tab: all users, all
  reports, app controls, inbox). So make your own account **first**, before
  sharing the link with anyone.
- Every signup gets **8 backup codes**, shown only once. Save them — a
  forgotten password is recovered with a backup code (there is no OTP and no
  email reset in this app).
- Later, if users must move to a new phone, they just log in with the same
  email + password; all their reports, groups and settings come back because
  everything is saved on the server under their account.

## Run it locally (testing)

```bash
npm install
npm run build      # builds the web app into dist/
npm start          # http://localhost:8793 — app + API on one origin
```

Without `TURSO_DATABASE_URL` it uses a local file DB at `data/daily-niyam.db`.

## Good to know

- **Announcements / maintenance / updates** are controlled from
  Admin → App Controls: a banner for everyone, a maintenance switch, and the
  latest-version fields that make the in-app **update popup** appear.
- **Notifications**: the 9 PM reminder and the smaran bell ring while the web
  app is open. A fully closed web app cannot ring — background delivery comes
  with the future Android app, which will use this same server and accounts.
