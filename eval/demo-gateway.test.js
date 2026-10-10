const test = require('node:test');
const assert = require('node:assert/strict');
const { createDemo } = require('../server/demo');
const { createHash } = require('node:crypto');
const code = 'ROODY-TEST-CODE';
const env = { OPENAI_API_KEY: 'sk-owner-key-must-stay-server', ADMIN_KEY: 'owner-admin-password', ROODY_DEMO_CODES: code, UPSTASH_REDIS_REST_URL: 'https://ledger.test', UPSTASH_REDIS_REST_TOKEN: 'ledger-secret' };
function fixture({ failProvider = false, missing = false } = {}) {
  const ledger = new Map(), network = [], jobs = [], sleeps = [];
  let releaseTimer;
  const fetcher = async (url, options) => {
    network.push({ url, options });
    if (url === env.UPSTASH_REDIS_REST_URL) {
      const [cmd, ...args] = JSON.parse(options.body); let result;
      if (cmd === 'GET') result = ledger.get(args[0]) || null;
      if (cmd === 'SET') { ledger.set(args[0], args[1]); result = 'OK'; }
      if (cmd === 'EVAL') {
        const [script, count, ...rest] = args; const keys = rest.slice(0, count), values = rest.slice(count);
        if (script.includes('local used')) {
          const used = Number(ledger.get(keys[0]) || 0), daily = Number(ledger.get(keys[1]) || 0);
          const status = ledger.has(keys[2]) ? -2 : used + values[0] > values[1] ? -1 : daily + values[0] > values[2] ? -3 : 1;
          if (status === 1) { ledger.set(keys[0], used + values[0]); ledger.set(keys[1], daily + values[0]); ledger.set(keys[2], values[3]); }
          result = [status, status === 1 ? used + values[0] : used];
        } else if (script.includes('DECRBY')) {
          if (ledger.get(keys[2]) === values[1]) { for (const key of keys.slice(0,2)) ledger.set(key, Number(ledger.get(key)) - values[0]); ledger.delete(keys[2]); } result = 1;
        } else { if (ledger.get(keys[0]) === values[0]) ledger.delete(keys[0]); result = 1; }
      }
      return { ok: true, json: async () => ({ result }) };
    }
    if (failProvider) return { ok: false, status: 401, text: async () => 'sk-secret-provider-error' };
    if (url.endsWith('/hangup')) return { ok: true };
    if (url.endsWith('/calls')) return { ok: true, headers: { get: () => '/v1/realtime/calls/rtc_test' }, text: async () => 'v=0\r\nanswer' };
    return { ok: true, json: async () => ({ output: [{ content: [{ type: 'output_text', text: 'Let us inspect the login handler.' }] }] }) };
  };
  const make = () => createDemo({ env: missing ? {} : env, fetcher, defer: promise => jobs.push(promise), delay: async ms => { sleeps.push(ms); if (ms === 180000) await new Promise(resolve => { releaseTimer = resolve; }); } });
  let handler = make();
  const request = async (body, authorization = code) => {
    const res = { headers: {}, setHeader(k,v) { this.headers[k]=v; }, end(value) { this.value=value; } };
    await handler({ method: 'POST', body, headers: { authorization: 'Bearer ' + authorization } }, res);
    return { status: res.statusCode, body: JSON.parse(res.value), headers: res.headers };
  };
  return { request, ledger, network, jobs, sleeps, restart() { handler=make(); }, async finish() { releaseTimer?.(); await Promise.all(jobs); } };
}
test('demo is closed when required server secrets or the code are missing', async () => {
  const f=fixture({missing:true}); assert.equal((await f.request({action:'balance'})).status,503); assert.equal(f.network.length,0);
  const g=fixture();assert.equal((await g.request({action:'chat',text:'hello'},'wrong')).status,403);assert(!g.network.some(x=>x.url.includes('openai')));
});
test('100 demo credits survive server restart and one text reply costs one credit', async () => {
  const f=fixture();const r=await f.request({action:'chat',text:'Help me',context:'login code'});assert.equal(r.body.remaining,99);f.restart();assert.equal((await f.request({action:'balance'})).body.remaining,99);
  assert(!JSON.stringify(r).includes(env.OPENAI_API_KEY));const provider=f.network.find(x=>x.url.endsWith('/responses'));assert.equal(provider.options.headers.authorization,'Bearer '+env.OPENAI_API_KEY);assert.equal(JSON.parse(provider.options.body).store,false);
});
test('voice reserves 30 credits, rejects concurrent use, and server hangs up after three minutes', async () => {
  const f=fixture();const r=await f.request({action:'voice',sdp:'v=0\r\noffer'});assert.equal(r.body.remaining,70);assert.equal(r.body.seconds,180);assert.deepEqual(f.sleeps,[180000]);assert.equal(f.jobs.length,1);assert(!JSON.stringify(r).includes(env.OPENAI_API_KEY));
  assert.equal((await f.request({action:'voice',sdp:'v=0'})).status,409);await f.finish();assert(f.network.some(x=>x.url.endsWith('/rtc_test/hangup')));
});
test('Pause hangs up the server call and another code cannot stop it', async () => {
  const f=fixture();const r=await f.request({action:'voice',sdp:'v=0'});assert.equal((await f.request({action:'stop',sessionId:r.body.sessionId},'wrong')).status,403);assert.equal((await f.request({action:'stop',sessionId:r.body.sessionId})).body.ok,true);await f.finish();
});
test('provider failure refunds reserved credits without echoing provider errors', async () => {
  const f=fixture({failProvider:true});const r=await f.request({action:'voice',sdp:'v=0'});assert.equal(r.status,502);assert.equal((await f.request({action:'balance'})).body.remaining,100);assert(!JSON.stringify(r).includes('sk-secret'));assert.equal(f.jobs.length,0);
});
test('a spent code cannot reset its balance by restarting or reinstalling', async () => {
  const f=fixture();const id=createHash('sha256').update(code).digest('hex');f.ledger.set('roody:demo:v1:used:'+id,100);f.restart();assert.equal((await f.request({action:'chat',text:'hello'})).status,402);assert(!f.network.some(x=>x.url.includes('openai')));
});
test('admin password can mint a fresh 100-credit code; a guest cannot', async () => {
  const f=fixture();assert.equal((await f.request({action:'mint'})).status,403);const minted=await f.request({action:'mint'},env.ADMIN_KEY);assert.match(minted.body.code,/^ROODY-[A-F0-9]{24}$/);assert.equal((await f.request({action:'balance'},minted.body.code)).body.remaining,100);assert(!JSON.stringify(minted).includes(env.ADMIN_KEY));
});
test('unexpected actions and oversized input cannot spend credits', async () => {
  const f=fixture();assert.equal((await f.request({action:'token'})).status,400);assert.equal((await f.request({action:'chat',text:'a'.repeat(4001)})).status,400);assert.equal((await f.request({action:'voice',sdp:'bad'})).status,400);assert.equal((await f.request({action:'balance'})).body.remaining,100);
});
