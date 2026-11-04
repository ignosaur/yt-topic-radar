import { expect, test } from 'bun:test';
import { countBucket, durationBucket, scanErrorClass, importErrorClass, buildCapturePayload, browserBucket } from '../ui/telemetry-utils.js';
const source = await Bun.file(`${import.meta.dir}/../ui/digest.js`).text();
function harness(start: string, end: string, overrides: any = {}) {
  const handlers: Record<string, any> = {};
  const nodes = new Map();
  const events: any[] = [];
  const h: any = {
    state: { sync: { topics: ['PRIVATE_TOPIC'], telemetryOptIn: true }, digests: {}, metrics: { videosSummarized: 10, slopVideosFiltered: 4, secondsSaved: 100 } },
    activeTopic: 'PRIVATE_TOPIC', scanningTopic: '', isServerOffline: false,
    initialLoadDone: false, starterAutoCollapsedOnce: true,
    location: { search: '', pathname: '/' }, history: {},
    countBucket, durationBucket, scanErrorClass, importErrorClass,
    captureUsage: (event: string, props: any) => { events.push({event,props}); },
    captureDashboardOpened: () => { events.push({event:'dashboard_opened'}); },
    el: (id: string) => {
      if (!nodes.has(id)) nodes.set(id, { value: '3', classList: { remove() {}, add() {} }, addEventListener: (_: string, cb: any) => { handlers[id] = cb; } });
      return nodes.get(id);
    },
    fetch: async () => Response.json({}),
    loadState: async () => { h.state.metrics = { videosSummarized: 999 }; },
    renderSidebar() {}, renderMainDigest() {}, renderAll() {}, renderMetricsUI() {},
    setOfflineMode() {}, resetRssUnread() {}, showToast() {},
    isServerUnreachable: () => false, serverUnreachableToast() {},
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
    document: { body: { appendChild() {} }, createElement: () => ({click() {},remove() {}}) },
    ...overrides,
  };
  const body = source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
  return { h, handlers, events, run: () => new Function('h', `with(h) { ${body} }`)(h), body };
}
for (const error of [null, 'quota_exhausted','rate_limited','invalid_api_key','gemini_api_not_enabled','provider_unavailable','scan_timeout','scan_in_progress','topic_changed','surprise','network']) {
  test(`scan emits one start and terminal: ${error ?? 'success'}`, async () => {
    const t = harness('el("btnScanTopic").addEventListener("click",', '// 1-Click Export Backup', {
      fetch: async () => {
        if (error === 'network') throw new TypeError('PRIVATE_NETWORK_MESSAGE');
        return Response.json(error ? {error} : {digest:{videos:[{},{}], requestedCount:3,skippedVideos:[{}]},metrics:{videosSummarized:12,slopVideosFiltered:5,secondsSaved:150}}, {status:error?400:200});
      },
    });
    t.run(); await t.handlers.btnScanTopic();
    expect(t.events.map(e=>e.event)).toEqual(['scan_started',error?'scan_failed':'scan_completed']);
    if (error) expect(t.events[1].props.error_class).toBe(scanErrorClass(error));
    else expect(t.events[1].props).toEqual({duration_bucket:'0-5s',videos_summarized:2,requested_count:3,skipped_count:1,slop_filtered:1,seconds_saved_delta:50});
    expect(JSON.stringify(t.events)).not.toContain('PRIVATE');
    expect(t.h.scanningTopic).toBe('');
  });
}
test('offline and re-entrant scans send nothing', async () => {
  for (const options of [{isServerOffline:true},{scanningTopic:'busy'},{activeTopic:''}]) {
    const t = harness('el("btnScanTopic").addEventListener("click",','// 1-Click Export Backup',options);
    t.run();await t.handlers.btnScanTopic();expect(t.events).toEqual([]);
  }
});
test('dashboard open happens only on first successful load', async () => {
  const t = harness('async function loadState(', 'async function saveSync(', {
    fetch:async()=>Response.json({sync:{topics:[]},digests:{},metrics:{}}),
  });
  const load = new Function('h',`with(h) { ${t.body}; return loadState; }`)(t.h);
  await load();await load();expect(t.events).toEqual([{event:'dashboard_opened'}]);
});
test('timestamp and TTS emit only after successful local metric writes', async () => {
  for (const ok of [true,false]) {
    const t = harness('async function recordMetricEvent(', '// --- Anonymous usage capture', {fetch:async()=>Response.json({}, {status:ok?200:500})});
    const record = new Function('h',`with(h) { ${t.body}; return recordMetricEvent; }`)(t.h);
    await record('timestampClick');await record('ttsPlay');
    expect(t.events.map(e=>e.event)).toEqual(ok?['timestamp_clicked','tts_played']:[]);
  }
});
for (const error of [null,'Invalid backup JSON','Backup exceeds maximum size','network']) {
  test(`backup import event: ${error ?? 'success'}`, async () => {
    const t = harness('el("inputImportBackup").addEventListener','\nloadState();',{
      fetch:async()=>{if(error==='network')throw Error('network');return Response.json(error?{error}:{topicsCount:4,digestsCount:8},{status:error?400:200});},
    });
    t.run();await t.handlers.inputImportBackup({target:{files:[{text:async()=>'PRIVATE_BACKUP'}],value:'file'}});
    expect(t.events).toEqual([{event:error?'backup_import_failed':'backup_imported',props:error?{error_class:error==='network'?'unknown':importErrorClass(error)}:{topics_count_bucket:'2-5',digests_count_bucket:'6+'}}]);
  });
}
for (const ok of [true,false]) test(`backup export event ${ok}`, async()=>{
  const t=harness('el("btnExportBackup").addEventListener','// 1-Click Import Backup',{fetch:async()=>new Response('{}',{status:ok?200:500})});
  t.run();await t.handlers.btnExportBackup();expect(t.events[0].event).toBe(ok?'backup_exported':'backup_export_failed');
});
test('sender gates, identity race, persistence, notice order, and network failure', async()=>{
  const body=source.slice(source.indexOf('let telemetryIdentity;'),source.indexOf('async function loadState('));
  for(const mode of ['standalone','off','dev','missing-key','reject']) {
    const sent:any[]=[];const local:any={};const order:string[]=[];
    const h:any={STANDALONE_ROUTE:mode==='dev'?null:()=>{},POSTHOG_KEY:mode==='missing-key'?'':'public-token',POSTHOG_HOST:'https://eu.i.posthog.com',state:{sync:{telemetryOptIn:mode!=='off',topics:[]},digests:{}},
      ensureTelemetryNotice:async()=>{order.push('notice');},
      chrome:{storage:{local:{get:async()=>({...local}),set:async(v:any)=>Object.assign(local,v)}},runtime:{getManifest:()=>({version:'1.0.0'})}},
      crypto,navigator:{userAgent:'Chrome/123'},browserBucket,buildCapturePayload,countBucket,
      origFetch:async(_:string,init:any)=>{order.push('send');sent.push(JSON.parse(init.body));if(mode==='reject')throw Error('offline');},
    };
    const capture=new Function('h',`with(h) { ${body}; return captureUsage; }`)(h);
    await Promise.all([capture('api_key_saved'),capture('timestamp_clicked')]);
    if(['off','dev','missing-key'].includes(mode)){expect(sent).toEqual([]);expect(local.radarAnonId).toBeUndefined();}
    else {expect(sent).toHaveLength(2);expect(sent[0].distinct_id).toBe(sent[1].distinct_id);expect(sent[0].distinct_id).toBe(local.radarAnonId);expect(order.indexOf('notice')).toBeLessThan(order.indexOf('send'));h.state.sync.telemetryOptIn=false;await capture('tts_played');expect(sent).toHaveLength(2);}
  }
});
