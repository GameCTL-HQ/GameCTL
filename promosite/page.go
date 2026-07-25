package main

// pageHTML is a single self-contained page — no build step, no external
// assets except a system font stack, so the image stays tiny and works
// offline. {{.Title}}/{{.Accent}} are the only server-templated bits;
// everything else (the actual server list) is filled in client-side from
// /api/servers.json so the page can auto-refresh without a reload.
const pageHTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{{.Title}}</title>
<style>
  :root { --accent: {{.Accent}}; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; background: #0a0a0a; color: #f5f5f5;
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  header {
    padding: 2rem 1.5rem 1rem; text-align: center; border-bottom: 1px solid #262626;
  }
  header h1 { margin: 0; font-size: 1.75rem; font-weight: 800; }
  header p { margin: .5rem 0 0; color: #a3a3a3; font-size: .875rem; }
  main {
    max-width: 72rem; margin: 0 auto; padding: 2rem 1.5rem;
    display: grid; gap: 1.25rem; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  }
  .card {
    border: 1px solid #262626; border-radius: .75rem; padding: 1.25rem;
    background: #141414;
  }
  .card h2 { margin: 0 0 .5rem; font-size: 1.1rem; }
  .row { display: flex; align-items: center; gap: .5rem; margin-bottom: .5rem; font-size: .8rem; color: #a3a3a3; }
  .dot { width: .55rem; height: .55rem; border-radius: 999px; background: #525252; flex-shrink: 0; }
  .dot.online { background: #22c55e; }
  .dot.offline { background: #ef4444; }
  .stat { font-size: .8rem; color: #d4d4d4; }
  .stat b { color: #fff; }
  .empty { color: #737373; font-size: .9rem; text-align: center; padding: 3rem 1rem; grid-column: 1 / -1; }
  footer { text-align: center; padding: 2rem 1rem; color: #525252; font-size: .75rem; }
  a { color: var(--accent); }
</style>
</head>
<body>
<header>
  <h1>{{.Title}}</h1>
  <p>Live server status, refreshed automatically</p>
</header>
<main id="grid">
  <p class="empty">Loading…</p>
</main>
<footer>Powered by <a href="https://gamectl.cc" target="_blank" rel="noreferrer">GameCTL</a>'s Stats API</footer>
<script>
(function(){
  const grid = document.getElementById('grid');

  function render(servers) {
    const keys = Object.keys(servers || {});
    if (!keys.length) {
      grid.innerHTML = '<p class="empty">No servers are currently advertised.</p>';
      return;
    }
    grid.innerHTML = keys.sort().map(function(slug) {
      const s = servers[slug] || {};
      const status = s.status || 'unknown';
      const name = s.server_name || slug;
      const players = (s.players != null || s.max_players != null)
        ? (s.players != null ? s.players : '?') + '/' + (s.max_players != null ? s.max_players : '?')
        : null;
      return '<div class="card">' +
        '<div class="row"><span class="dot ' + esc(status) + '"></span>' +
        '<span style="text-transform:capitalize">' + esc(status) + '</span></div>' +
        '<h2>' + esc(name) + '</h2>' +
        (players ? '<p class="stat">Players: <b>' + esc(players) + '</b></p>' : '') +
        (s.map ? '<p class="stat">Map: <b>' + esc(s.map) + '</b></p>' : '') +
        '</div>';
    }).join('');
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function(c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function poll() {
    fetch('/api/servers.json', { cache: 'no-store' })
      .then(function(r) { return r.json(); })
      .then(function(j) { render(j.servers); })
      .catch(function() { /* keep showing the last good render */ });
  }

  poll();
  setInterval(poll, 15000);
})();
</script>
</body>
</html>
`
