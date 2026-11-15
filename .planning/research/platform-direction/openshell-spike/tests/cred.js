const k = process.env.NEARAI_API_KEY;
console.log('C1 agent sees NEARAI_API_KEY =', k);
console.log('C2 agent env contains FAKE-NEARAI-KEY ?', JSON.stringify(process.env).includes('FAKE-NEARAI-KEY'));
async function go(label, url, opts) { try { const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(15000) }); console.log(label, 'HTTP', r.status, (await r.text()).slice(0, 160)); } catch (e) { console.log(label, 'ERROR', e.cause?.code || '', (e.cause?.message || e.message).slice(0, 160)); } }
(async () => {
  await go('C3 bearer to bound endpoint:', 'http://host.openshell.internal:18555/v1/chat', { headers: { authorization: `Bearer ${k}` } });
  await go('C4 placeholder in body (no body rewrite enabled):', 'http://host.openshell.internal:18555/v1/body', { method: 'POST', body: JSON.stringify({ key: k }) });
  await go('C5 bearer to a different allowed host (npm):', 'https://registry.npmjs.org/left-pad', { headers: { authorization: `Bearer ${k}` } });
  await go('C6 placeholder moved to query string:', `http://host.openshell.internal:18555/v1/q?key=${encodeURIComponent(k)}`, {});
})();
