# Veritas Dashboard

Static GitHub Pages dashboard for Rosary sessions and Bible quiz scores.

## Configure

Edit `config.js`:

```js
window.VERITAS_DASHBOARD_CONFIG = {
  pocketBaseUrl: "https://your-pocketbase-url.example.com",
  refreshSeconds: 60,
};
```

The dashboard reads these PocketBase collections:

- `rosary_sessions`
- `rosary_attendance`
- `bible_trivia_scores`

Those collections need public read rules for GitHub Pages to fetch them directly.

Rosary durations are displayed with a 20% reduction to account for normal
pre-start loitering. Rosary streaks are calculated from consecutive recent
Rosary sessions attended by a user. Bible quiz streaks would require per-answer
history, so the current quiz display is daily, weekly, and all-time score based.

## Deploy

The repository includes a GitHub Actions workflow that deploys this folder to
GitHub Pages. In GitHub, set Pages to use **GitHub Actions** as the source.
