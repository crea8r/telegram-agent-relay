# Admin UI

## Access

1. Set `ADMIN_PASSWORD` in `.env`
2. Run server
3. Open `http://localhost:8787/admin/ui/index.html`
4. Login to access dashboard

## What it shows

- Metrics: events, stopped, warned, delivered, failed
- Sessions table (from SQLite)
- Recent loop decisions
- Recent delivery attempts and retries

## API used by UI

- `POST /admin/login`
- `POST /admin/logout`
- `GET /admin/api/metrics`
- `GET /admin/api/sessions`
- `GET /admin/api/loops`
- `GET /admin/api/deliveries`

## Storage

All monitoring data is persisted in SQLite (`SQLITE_PATH`):
- events
- loop_decisions
- deliveries
