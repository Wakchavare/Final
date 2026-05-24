# Deployment

Run this folder with Docker Compose:

```bash
docker compose up --build -d
```

Open:

- Frontend: `http://localhost:8080`
- Backend health: `http://localhost:3000/api/health`

Do not open `/api/auth/login` directly. It is a POST-only API endpoint used by the login form.

After startup, run the deployment test:

```bash
chmod +x test-deployment.sh
./test-deployment.sh
```

For domain testing after DNS/proxy is pointed at the server:

```bash
BASE_URL=http://uniquedesignscasting.com FRONTEND_URL=http://uniquedesignscasting.com ./test-deployment.sh
```

This Compose file builds:

- `../frontend` as the Nginx frontend container
- `../backend` as the Express API container
- `postgres:16-alpine` as the PostgreSQL database

Temporary production `DATABASE_URL`:

```env
postgres://casting_user:casting_password@postgres:5432/casting_production
```

Change `JWT_SECRET`, `POSTGRES_PASSWORD`, and database credentials before final production use.
