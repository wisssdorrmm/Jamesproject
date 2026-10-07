# Schoolhouse

A school management system: Node.js + Express, SQLite via libSQL (local file or Turso), JWT auth, plain HTML/CSS/JS frontend.

## Features

- **Owner / admin panel**: stats, create accounts, change anyone's role (including making owners), reset passwords, disable/remove accounts, search and filter people, school-wide announcements.
- **Teachers**: create classes (join codes), post assignments, read submissions, grade with feedback, class announcements.
- **Students**: join classes by code, submit work, see grades and feedback.
- Everyone: edit profile name, change password.

## Run locally

Requires Node.js 18+.

```bash
npm install
cp .env.example .env
npm start
```

Open http://localhost:3000. With `TURSO_DATABASE_URL` blank, data is stored in `data/school.db`.

## Owner accounts

Emails in `OWNER_EMAILS` become owner when they sign up (or on next start if the account exists).
Other owners are made from the **People** page. The app always keeps one active owner.

## Deploy on Vercel

1. Create a free database at https://turso.tech (Dashboard > Create Database). Copy its URL (`libsql://...`) and create a token (read & write).
2. Push this project to GitHub and import it in Vercel.
3. In Vercel > Project > Settings > Environment Variables add:
   - `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`
   - `JWT_SECRET` (any long random string)
   - `OWNER_EMAILS` (e.g. `wisdomudoudo24@gmail.com`)
4. Redeploy (Deployments > ... > Redeploy), then open the site and sign up with an owner email before sharing the link.

`api/index.js` is the serverless entry point and `vercel.json` routes `/api/*` to it; `public/` is served as static files.
