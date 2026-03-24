# Capsen 🏓

Mobile-first party game tracker for Capsen (beer pong variant). Dark "Sports Bar" themed PWA built with Node.js and Express.

## Features

- **4 Game Modes** — 1v1, 2v2, Flip Cup, and Tournament brackets
- **Player Profiles** — Avatars with Cropper.js, custom colors, email notifications
- **Leaderboard** — Overall rankings, head-to-head comparisons, dominance stats
- **Tournaments** — Auto-generated single-elimination brackets with bye handling
- **Email Notifications** — Match results and weekly top 3 summaries (via Gmail SMTP)
- **PWA** — Installable on mobile, standalone mode, dark theme

## Tech Stack

- **Runtime:** Node.js 22 (Alpine)
- **Framework:** Express 4
- **Database:** SQLite via better-sqlite3
- **Upload:** Multer + Cropper.js (client-side crop)
- **Email:** Nodemailer (Gmail)
- **Deploy:** Docker + Traefik reverse proxy

## Quick Start

### Local Development

```bash
npm install
npm run dev
```

App runs on [http://localhost:3000](http://localhost:3000).

### Docker (Production)

```bash
docker compose up --build -d
docker logs -f capsportal
```

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `PORT` | Server port | `3000` |
| `HOUSE_PASSWORD` | Shared password for login/registration | `change-me` |
| `SESSION_SECRET` | Cookie signing secret | `dev-secret` |
| `SMTP_USER` | Gmail address for notifications | _(empty)_ |
| `SMTP_PASS` | Gmail app password | _(empty)_ |
| `GOOGLE_DRIVE_PHOTOS_FOLDER_ID` | Drive folder for photo sync (TODO) | — |
| `GOOGLE_DRIVE_BACKUP_FOLDER_ID` | Drive folder for DB backups (TODO) | — |

## Project Structure

```
capsportal/
├── server.js            # Full application (routes, DB, templates)
├── package.json
├── Dockerfile
├── docker-compose.yml   # Traefik labels for HTTPS
├── .env.example
├── public/
│   ├── manifest.json    # PWA manifest
│   ├── icon-192.png     # Auto-generated placeholder
│   └── icon-512.png     # Auto-generated placeholder
└── storage/
    ├── capsen.db        # SQLite database (auto-created)
    └── uploads/         # Avatar & match photos
```

## Deployment

The app runs behind Traefik on a Hostinger VPS. Traefik handles HTTPS via Let's Encrypt automatically. The container joins the `openclaw-rozz_default` Docker network.

```bash
# On VPS in /var/www/spielportal/
docker compose down --remove-orphans
docker compose up --build -d
```

## License

Private project.
