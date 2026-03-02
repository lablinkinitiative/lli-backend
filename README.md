# LabLink Initiative — Backend API

Node.js/Express REST API with SQLite. Runs at `app.lablinkinitiative.org`.

## Modules

| Module | Endpoints | Description |
|--------|-----------|-------------|
| Labs | `GET/POST/PATCH /api/labs` | Lab management |
| Equipment | `GET/POST/PATCH/DELETE /api/equipment` | Equipment catalog |
| Bookings | `GET/POST/PATCH/DELETE /api/bookings` | Equipment scheduling with conflict detection |
| Waitlist | `GET/POST/PATCH/DELETE /api/waitlist` | Waitlist management |
| Experiments | `GET/POST/PATCH/DELETE /api/labs/:slug/experiments` | Lab notebook |
| Reagents | `GET/POST/PATCH/DELETE /api/reagents` + usage log + alerts | Reagent inventory |
| Calibrations | `GET/POST/PATCH/DELETE /api/calibrations` + compliance | Equipment calibration |

## Quick Start

```bash
npm install
node server.js
```

## API Reference

### Health
```
GET /health
```

### Labs
```
GET  /api/labs
GET  /api/labs/:slug
POST /api/labs
PATCH /api/labs/:slug
```

### Equipment
```
GET    /api/equipment?lab=bio-lab&status=available
GET    /api/equipment/:id
POST   /api/equipment
PATCH  /api/equipment/:id
DELETE /api/equipment/:id
```

### Bookings
```
GET    /api/bookings?equipment_id=1&lab_slug=bio-lab
GET    /api/bookings/:id
POST   /api/bookings
PATCH  /api/bookings/:id
DELETE /api/bookings/:id
POST   /api/bookings/check-availability
```

### Waitlist
```
GET    /api/waitlist?equipment_id=1
GET    /api/waitlist/:id
GET    /api/waitlist/equipment/:id/position?user_email=...
POST   /api/waitlist
PATCH  /api/waitlist/:id
DELETE /api/waitlist/:id
```

### Lab Notebook (Experiments)
```
GET    /api/labs/:slug/experiments
GET    /api/labs/:slug/experiments/:id
POST   /api/labs/:slug/experiments
PATCH  /api/labs/:slug/experiments/:id
DELETE /api/labs/:slug/experiments/:id
```

### Reagents
```
GET    /api/reagents?lab_slug=bio-lab&status=low-stock
GET    /api/reagents/:id
POST   /api/reagents
PATCH  /api/reagents/:id
DELETE /api/reagents/:id
GET    /api/reagents/:id/usage
POST   /api/reagents/:id/usage
GET    /api/reagents/alerts/low-stock
GET    /api/reagents/inventory/value
```

### Calibrations
```
GET    /api/calibrations?lab_slug=bio-lab&compliance=overdue
GET    /api/calibrations/:id
GET    /api/calibrations/equipment/:id
POST   /api/calibrations
PATCH  /api/calibrations/:id
DELETE /api/calibrations/:id
GET    /api/calibrations/compliance/summary
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | HTTP port |
| `DB_PATH` | `./data/lablink.db` | SQLite database path |

## Deployment

Runs as a systemd service: `lablink-api.service`

```bash
systemctl status lablink-api
journalctl -u lablink-api -f
```
