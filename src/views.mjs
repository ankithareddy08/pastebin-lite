function escapeHtml(value) {
  return String(value).replace(/[&<>"'\r]/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '\r': '&#13;',
  })[character]);
}

function layout(title, content) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>${escapeHtml(title)} | Pastebin Lite</title>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/styles.css">
  <script src="/app.js" defer></script>
</head>
<body>
  <a class="skip-link" href="#main">Skip to content</a>
  <div class="page-shell">
    <header class="site-header">
      <a class="brand" href="/" aria-label="Pastebin Lite home"><span class="brand-mark" aria-hidden="true">[ / ]</span><span class="brand-name">Pastebin <span>Lite</span></span></a>
      <a class="text-link" href="/">Create a paste <span aria-hidden="true">↗</span></a>
    </header>
    <main id="main">${content}</main>
    <footer class="site-footer"><span>Pastebin Lite</span><span>Text, simply shared.</span></footer>
  </div>
</body>
</html>`;
}

export function renderPaste(paste) {
  const views = paste.remaining_views === null ? 'Unlimited views'
    : `${paste.remaining_views} ${paste.remaining_views === 1 ? 'view' : 'views'} remaining`;
  const expiry = paste.expires_at === null ? 'No expiry'
    : `Expires ${escapeHtml(paste.expires_at.replace('T', ' ').replace('.000Z', ' UTC'))}`;
  return layout('Shared paste', `
    <section class="viewer-intro">
      <p class="eyebrow">A LITTLE TEXT, PASSED ALONG</p>
      <h1>Your shared paste.</h1>
      <p>Just the text, exactly as it was shared.</p>
    </section>
    <section class="viewer-card" aria-label="Shared text">
      <div class="viewer-toolbar">
        <div class="viewer-meta"><span class="pill">Plain text</span><span>${views}</span><span>${expiry}</span></div>
        <button type="button" class="button button-secondary" data-copy-target="paste-content">Copy text</button>
      </div>
      <pre class="paste-content"><code id="paste-content">${escapeHtml(paste.content)}</code></pre>
      <div class="viewer-footer"><span>${paste.remaining_views === 0 ? 'This was the last available view. Opening the link again will show an unavailable page.' : 'Each page visit counts as one view. Copying this text does not use another view.'}</span><span data-copy-feedback role="status" aria-live="polite"></span></div>
    </section>`);
}

export function renderError(status, message) {
  const title = status === 404 ? 'This paste is unavailable.' : status === 503 ? 'Please try again shortly.' : 'We could not open this page.';
  return layout(title, `
    <section class="error-card" aria-labelledby="error-title">
      <span class="empty-icon" aria-hidden="true">${status}</span>
      <h1 id="error-title">${title}</h1>
      <p>${escapeHtml(message)}</p>
      <a class="button button-primary" href="/">Create a new paste <span aria-hidden="true">↗</span></a>
    </section>`);
}
