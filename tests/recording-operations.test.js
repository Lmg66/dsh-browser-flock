import test from 'node:test';
import assert from 'node:assert/strict';
import {Operations} from '../src/host/operations.js';
import {parseJson} from '../src/shared/rpc.js';
import {apply as applyTools} from '../src/host/tools.js';
test('recording dispatcher exposes cross-conversation reads and rejects invalid inputs before effects',async()=>{
 const calls=[];const recordings=Object.fromEntries(['start','stop','delete','list','get','listEvents','getRequest'].map(method=>[method,args=>{calls.push({method,args});return method==='list'?{items:[],total:0}: {id:'recording'};} ]));
 const operations=new Operations({snapshot:()=>({})},{freshness:()=>({})},{},{recordings});
 const cases=[['start_browser_recording',{instance_id:'instance',name:'Manual run'},'start'],['stop_browser_recording',{recording_id:'recording'},'stop'],['delete_browser_recording',{recording_id:'recording'},'delete'],['list_browser_recordings',{},'list'],['get_browser_recording',{recording_id:'recording'},'get'],['list_browser_recording_events',{recording_id:'recording',limit:50},'listEvents'],['get_browser_recording_request',{recording_id:'recording',request_id:'request'},'getRequest']];
 for(const [action,args,method] of cases){const result=parseJson(await operations.dispatch({action,args}));assert.equal(result.ok,true);assert.equal(calls.at(-1).method,method);assert.deepEqual(calls.at(-1).args,args);}
 for(const [action,args] of [['start_browser_recording',{}],['start_browser_recording',{instance_id:'instance',name:'x'.repeat(121)}],['delete_browser_recording',{}],['delete_browser_recording',{recording_id:'recording',force:true}],['get_browser_recording',{}],['list_browser_recording_events',{recording_id:'recording',limit:101}],['get_browser_recording_request',{recording_id:'recording'}]]){const count=calls.length;assert.equal((await operations.dispatch({action,args})).error.code,'INVALID_ARGUMENT');assert.equal(calls.length,count);}
 const tools=new Map();applyTools({tools:{register:tool=>tools.set(tool.name,tool)},sandboxPolicy:{resolve:()=>({mode:'danger-full-access'})},browserFlock:operations,get:()=>undefined});
 const deleted=JSON.parse(await tools.get('delete_browser_recording').execute({recording_id:'recording'},{signal:new AbortController().signal}));
 assert.equal(deleted.ok,true);assert.equal(calls.at(-1).method,'delete');
 assert.deepEqual(operations.snapshot().recordings,[]);
});
