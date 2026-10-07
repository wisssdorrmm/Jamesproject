# Schoolhouse

A simple school management system.

- **Owner**: sees all students, teachers and assignments. Can remove accounts and assignments.
- **Teacher**: signs up, posts assignments, sees all students.
- **Student**: signs up, sees all assignments.

Stack: Node.js, Express, SQLite (better-sqlite3), JWT auth, plain HTML/CSS/JS frontend. No external services needed.

## Run it

Requires Node.js 18 or newer.

```bash
npm install
cp .env.example .env     # on Windows: copy .env.example .env
npm start
```

Open http://localhost:3000

## Owner login

The owner account is created on first start from `OWNER_EMAIL` and `OWNER_PASSWORD` in `.env`
(defaults: `owner@school.local` / `ChangeMe123!`). Change these before using it for real.
To re-seed the owner, stop the server, delete the `data/` folder, and start again (this wipes all data).

Teachers and students sign up from the app. Nobody can sign up as owner.

## API

| Method | Path | Who |
|---|---|---|
| POST | /api/auth/signup | public (teacher or student) |
| POST | /api/auth/login | public |
| GET | /api/me | any logged-in user |
| GET | /api/students | owner, teacher |
| GET | /api/teachers | owner |
| GET | /api/stats | owner |
| DELETE | /api/users/:id | owner |
| GET | /api/assignments | any logged-in user |
| POST | /api/assignments | teacher |
| PUT | /api/assignments/:id | the teacher who created it |
| DELETE | /api/assignments/:id | creating teacher, or owner |

## Deploying

Set `PORT`, `OWNER_*` and `JWT_SECRET` as environment variables on your host. The SQLite file lives in `data/`, so use a host with a persistent disk (Render, Railway, Fly.io, a VPS).
