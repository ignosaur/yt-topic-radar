// Isolated synthetic extension integration verification. Never uses the normal profile/store.
import { chromium } from '@playwright/test';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { strict as assert } from 'node:assert';
const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const evidence=`${root}/docs/evidence/2026-11-04-telemetry`;
await mkdir(evidence,{recursive:true});
const ctx=await chromium.launchPersistentContext(await mkdtemp('/tmp/radar-telemetry-wiring-'),{headless:false,args:['--headless=new','--no-sandbox',`--disable-extensions-except=${root}/extension`,`--load-extension=${root}/extension`]});
const events:any[]=[];const errors:string[]=[];
try {
 const sw=ctx.serviceWorkers()[0]||await ctx.waitForEvent('serviceworker');
 const page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));
 page.on('request',r=>{if(r.url().includes('eu.i.posthog.com/capture/'))events.push(JSON.parse(r.postData()!));});
 await page.goto(`chrome-extension://${new URL(sw.url()).host}/digest.html`);
 await page.waitForSelector('#btnSettingsToggle');await page.waitForTimeout(400);
 assert.equal(events.length,0,'opt-in OFF must send nothing');
 await page.evaluate(async()=>{
   await chrome.storage.local.set({radarTelemetryNoticeShown:false,radarAnonId:'d041af1b-9fe8-4bf8-86d1-c756aa301904'});
 });
 // Stub only scans at the standalone API boundary, leaving real key/backup/state/storage handling intact.
 await page.reload();
 await page.evaluate(()=>{
    let scan=0;
   // Digest captured original route at startup: intercept its native API fetch wrapper instead.
   const native=window.fetch;
   window.fetch=async(input:any,init:any)=>{
     if(input==='/api/scan') {
       scan++;
       if(scan>1)return Response.json({error:'quota_exhausted'}, {status:429});
       return Response.json({digest:{videos:[],requestedCount:3,skippedVideos:[{}]},metrics:{videosSummarized:2,slopVideosFiltered:1,secondsSaved:120}});
     }
     if(input==='/api/backup/export' && (window as any).failExport)return new Response('',{status:500});
     return native(input,init);
   };
 });
 await page.click('#btnSettingsToggle');await page.check('#telemetryToggle');
 await page.waitForTimeout(800);
 assert.equal(events.filter(e=>e.event==='dashboard_opened').length,1);
 assert.equal(await page.locator('#telemetryNotice').isVisible(),true);
 await page.fill('#apiKeyInput','SYNTHETIC_NOT_A_REAL_GEMINI_KEY');await page.click('#btnSaveKey');
 await page.fill('#newTopicInput','SYNTHETIC_PRIVATE_TOPIC');await page.locator('#addTopicForm button').click();
 await page.click('#btnScanTopic');await page.waitForTimeout(400);
 await page.click('#btnScanTopic');await page.waitForTimeout(400);
 const download=page.waitForEvent('download');await page.click('#btnExportBackup');await download;
 await page.evaluate(()=>{(window as any).failExport=true;});await page.click('#btnExportBackup');
 await page.setInputFiles('#inputImportBackup',{name:'corrupt.json',mimeType:'application/json',buffer:Buffer.from('{broken')});
 await page.waitForTimeout(400);
 const backup={version:1,exportedAt:new Date().toISOString(),sync:{topics:['SYNTHETIC_PRIVATE_TOPIC'],pinnedChannels:[],minDurationSec:180,telemetryOptIn:true},digests:{SYNTHETIC_PRIVATE_TOPIC:{topic:"SYNTHETIC_PRIVATE_TOPIC",generatedAt:new Date().toISOString(),crossVideoSynthesis:"Synthetic private synthesis",suggestedSubtopics:[],videos:[{videoId:"test-id",title:"SYNTHETIC_PRIVATE_VIDEO",channelName:"SYNTHETIC_PRIVATE_CHANNEL",channelId:"test-channel",url:"",durationSec:300,durationText:"5:00",signalScore:90,videoType:"tutorial",coreThesis:"Synthetic takeaway",chapterBreakdown:[{timestamp:"01:00",sectionTitle:"Synthetic chapter",keyPoints:["Synthetic point"]}],typeSpecificDetails:[],worthWatchingFull:"Yes",worthWatchingReason:"Synthetic",summarizedAt:new Date().toISOString()}]}},seenVideoIds:[]};
 await page.setInputFiles('#inputImportBackup',{name:'valid.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(backup))});
 await page.waitForTimeout(1000);
 await page.route("**/youtube.com/**",route=>route.abort());
 await page.locator("[data-ts]").first().click();
 await page.click("#btnReadSynthesis");
 await page.waitForTimeout(800);
 assert.equal(events.filter(e=>e.event==='dashboard_opened').length,1,'state reloads must not recount opens');
 const names=events.map(e=>e.event);
 for(const name of ['dashboard_opened','api_key_saved','scan_started','scan_completed','scan_failed','backup_exported','backup_export_failed','backup_imported','backup_import_failed','timestamp_clicked','tts_played'])assert(names.includes(name),`missing ${name}`);
 assert(events.every(e=>e.distinct_id==='d041af1b-9fe8-4bf8-86d1-c756aa301904'));
 assert(!JSON.stringify(events).includes('SYNTHETIC_'),'private test inputs leaked');
 await page.uncheck('#telemetryToggle');const before=events.length;await page.click('#btnExportBackup');await page.waitForTimeout(400);assert.equal(events.length,before);
 await page.reload();await page.waitForTimeout(500);assert.equal(events.length,before);
 assert.deepEqual(errors,[]);
 await page.screenshot({path:`${evidence}/extension-settings.png`,fullPage:true});
 await Bun.write(`${evidence}/browser-events.json`,JSON.stringify({synthetic:true,distinct_id:'d041af1b-9fe8-4bf8-86d1-c756aa301904',events:events.map(({api_key,...event})=>event),errors,checks:['default off','opt-in','notice','key save','scan success and quota failure','backup export/import success/failure','no private inputs','one dashboard open per load','opt-out','reload off']},null,2));
 console.log(JSON.stringify({events:names,errors}));
} finally {await ctx.close();}
