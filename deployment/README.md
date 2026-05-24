# Deployment

Run this folder with Docker Compose:

```bash
docker compose up --build -d
```

Open:

- Frontend: `http://localhost:8080`
- Backend health: `http://localhost:3000/api/health`

This Compose file builds:

- `../frontend` as the Nginx frontend container
- `../backend` as the Express API container
- `postgres:16-alpine` as the PostgreSQL database

Temporary production `DATABASE_URL`:

```env
postgres://casting_user:casting_password@postgres:5432/casting_production
```

Change `JWT_SECRET`, `POSTGRES_PASSWORD`, and database credentials before final production use.
