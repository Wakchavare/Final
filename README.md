# Casting Production Management - Organized Deploy Package

This zip is organized into three folders:

- `frontend/` - static HTML/CSS/JS UI served by Nginx
- `backend/` - Node.js/Express API, PostgreSQL schema, migrations, seed/reset scripts, and tests
- `deployment/` - Docker Compose and production environment files

## Default Login

- Email: `admin@example.com`
- Password: `Admin@123`

## Deploy With Docker

From the `deployment` folder:

```bash
cd deployment
docker compose up --build -d
```

Open:

- Frontend: `http://localhost:8080`
- Backend health: `http://localhost:3000/api/health`

The backend runs migrations and seed data on startup.

## Temporary Production Environment

The deployment folder includes `.env` and `.env.example`.

Current temporary values:

```env
DATABASE_URL=postgres://casting_user:casting_password@postgres:5432/casting_production
JWT_SECRET=temp-change-later-unique-designs-casting-2026-05-24-9b7d4c2f6a8e5d1c
CORS_ORIGIN=http://localhost:8080,http://localhost:3000,http://uniquedesignscasting.com,https://uniquedesignscasting.com,http://www.uniquedesignscasting.com,https://www.uniquedesignscasting.com
```

Change `JWT_SECRET`, `POSTGRES_PASSWORD`, and `DATABASE_URL` before permanent production use.

## Backend Commands

From the `backend` folder, with a PostgreSQL database available:

```bash
npm install
cp .env.example .env
npm run migrate
npm run seed
npm run reset-db
npm test
```

Schema SQL: `backend/db/schema.sql`

Seed script: `backend/src/seed.js`

## API Routes

- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`
- `GET /api/users`
- `POST /api/users`
- `PUT /api/users/:id`
- `GET /api/roles`
- `POST /api/roles`
- `PUT /api/roles/:id`
- `GET /api/wax-entries`
- `POST /api/wax-entries`
- `PUT /api/wax-entries/:id`
- `DELETE /api/wax-entries/:id`
- `GET /api/casting-orders`
- `PUT /api/casting-orders/:id/workflow`
- `GET /api/inventory/snapshot`
- `POST /api/metal-receiving`
- `POST /api/inventory-postings`
- `GET /api/invoicing/summary`
- `GET /api/invoicing/companies`
- `POST /api/invoicing/companies`
- `PUT /api/invoicing/companies/:id`
- `GET /api/invoicing/orders`
- `POST /api/invoicing/orders`
- `GET /api/invoicing/orders/:id`
- `PUT /api/invoicing/orders/:id`
- `POST /api/invoicing/orders/:id/generate`
- `GET /api/audit-logs`
- `GET /api/health`

## Browser Smoke Test

After Docker or local app is running:

```bash
cd backend
APP_URL=http://127.0.0.1:3000 npm run browser-smoke
```

The smoke test verifies login, wax entries, casting workflow, metal receiving, inventory, invoicing, roles, users, audit logs, fetch activity, and frontend errors.
