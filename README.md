# Veritas Dashboard

Static GitHub Pages dashboard for Rosary sessions and attendance.

## Configure

Edit `config.js`:

```js
window.VERITAS_DASHBOARD_CONFIG = {
  pocketBaseUrl: "https://your-pocketbase-url.example.com",
  refreshSeconds: 60,
};
```

For the current DigitalOcean deploy, PocketBase is available at:

```js
window.VERITAS_DASHBOARD_CONFIG = {
  pocketBaseUrl: "http://143.244.165.102:8090",
  refreshSeconds: 60,
};
```

GitHub Pages is served over HTTPS, so browsers may block direct fetches to an HTTP-only PocketBase URL as mixed content. Put PocketBase behind HTTPS before using this dashboard from Pages.

The dashboard reads these PocketBase collections:

- `rosary_sessions`
- `rosary_attendance`

Those collections need public read rules for GitHub Pages to fetch them directly.

Rosary durations are displayed with a 20% reduction to account for normal
pre-start loitering. Rosary streaks are calculated from consecutive recent
Rosary sessions attended by a user.

## Deploy

The repository includes a GitHub Actions workflow that deploys this folder to
GitHub Pages. In GitHub, set Pages to use **GitHub Actions** as the source.
