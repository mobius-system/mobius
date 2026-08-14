(async function loadLightMirror() {
  const sourceUrl = '/extension/mobius-home/';
  try {
    const response = await fetch(sourceUrl, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    let html = await response.text();
    html = html
      .replace('<html lang="zh-CN">', '<html lang="zh-CN" class="mobius-light">')
      .replace('<title>莫比乌斯 · Publication</title>', '<title>莫比乌斯 · 明亮版</title>')
      .replace(
        './assets/mobius-synergy.svg',
        '/extension/mobius-home-light/mobius-synergy-light.svg?v=1'
      )
      .replace(
        '<link rel="stylesheet" href="./styles.css" />',
        '<base href="/extension/mobius-home/" />\n' +
        '  <link rel="stylesheet" href="/extension/mobius-home/styles.css" />\n' +
        '  <link rel="stylesheet" href="/extension/mobius-home-light/light.css?v=3" />'
      )
      .replace(
        '<script type="module" src="./main.js"></script>',
        '<script>window.__MOBIUS_LIGHT__ = true; window.__EXT_NAME__ = "mobius-home-light";</script>\n' +
        '  <script type="module" src="/extension/mobius-home/main.js?v=light-2"></script>'
      );

    document.open();
    document.write(html);
    document.close();
  } catch (error) {
    document.body.innerHTML = '<main class="light-load-error" role="alert">明亮版暂时无法载入，请稍后刷新。</main>';
    console.error('[mobius-home-light] failed to load mirror', error);
  }
})();
