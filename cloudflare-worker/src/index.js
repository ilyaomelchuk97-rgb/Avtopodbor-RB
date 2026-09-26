const DEFAULT_HEALTH_URL = 'https://avtopodbor-rb.onrender.com/api/health';

function healthUrl(env) {
  const url = new URL(env.RENDER_HEALTH_URL || DEFAULT_HEALTH_URL);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.onrender.com')) {
    throw new Error('RENDER_HEALTH_URL must be an HTTPS onrender.com URL');
  }
  url.searchParams.set('_wake', String(Date.now()));
  return url;
}

async function wakeRender(env) {
  const url = healthUrl(env);
  const response = await fetch(url, {
    method: 'GET',
    redirect: 'follow',
    headers: {
      accept: 'application/json',
      'user-agent': 'MOTOR-BY-Cloudflare-Wake/1.0',
    },
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Render health check failed: HTTP ${response.status}`);

  let health = null;
  try { health = JSON.parse(body); } catch (_) {}
  if (health?.status && health.status !== 'ok') throw new Error(`Unexpected health status: ${health.status}`);

  return {
    ok: true,
    checkedAt: new Date().toISOString(),
    target: `${url.origin}${url.pathname}`,
    renderStatus: health?.status || 'reachable',
    version: health?.version || null,
  };
}

export default {
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(
      wakeRender(env)
        .then(result => console.log(JSON.stringify(result)))
        .catch(error => {
          console.error(JSON.stringify({ ok: false, checkedAt: new Date().toISOString(), error: error.message }));
          throw error;
        }),
    );
  },

  async fetch() {
    return Response.json({
      ok: true,
      service: 'MOTOR.BY Render wake scheduler',
      schedule: 'every 10 minutes',
      note: 'The public route does not ping Render; only the Cron Trigger does.',
    }, { headers: { 'cache-control': 'no-store' } });
  },
};
