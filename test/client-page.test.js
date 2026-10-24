import test from 'node:test';
import assert from 'node:assert/strict';
import {formatRecordingTime,recordingDisplayName,createPage,createClientRpc,reconcileInstanceResult,filterInstances,performInstanceMutation,pageDictionaries,snapshotNotice,cdpInstanceKey} from '../src/client/page.js';

test('Client first load uses one saved snapshot without listing, reconciliation or discovery',async()=>{
  const effects=[],writes=[],calls=[];
  const React={createElement:(type,props,...children)=>({type,props,children}),Fragment:'fragment',useState:value=>[value,next=>writes.push(next)],useRef:value=>({current:value}),useEffect:fn=>effects.push(fn),useSyncExternalStore:()=>{}};
  const snapshot={runtimes:[{id:'chrome',available:true,browser:'chrome'}],instances:[{id:'work',status:'running'}],default_runtime_id:'chrome',freshness:{runtimes:{state:'pending'},instances:{state:'pending'}}};
  const ctx={locale:{register:()=>{},bind:()=>key=>key},remote:{browserFlock:{dispatch:async request=>{calls.push(request);return {ok:true,value:{ok:true,data:snapshot}};}}}};
  createPage(React,ctx)();const cleanup=effects[0]();
  try {await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(calls,[{action:'get_browser_flock_snapshot',args:{}}]);assert.ok(writes.includes(snapshot.instances));assert.ok(writes.includes(snapshot.runtimes));assert.ok(writes.includes(true));}
  finally {cleanup();}
});

test('Proxy preset UI creates through the selected preset and quick launch opens settings',async()=>{
  const states=[],refs=[],effects=[],calls=[];let si=0,ri=0;
  const React={createElement:(type,props,...children)=>({type,props:props||{},children:children.flat(Infinity)}),Fragment:'fragment',useState:value=>{const i=si++;if(!(i in states))states[i]=value;return [states[i],next=>states[i]=typeof next==='function'?next(states[i]):next];},useRef:value=>{const i=ri++;return refs[i] ||= {current:value};},useEffect:fn=>effects.push(fn),useSyncExternalStore:()=>{}};
  const snapshot={runtimes:[{id:'chrome',name:'Chrome',available:true,browser:'chrome'}],instances:[],proxy_presets:[{id:'capture',name:'Capture',proxy:{mode:'http',host:'127.0.0.1',port:8888}}],default_runtime_id:'chrome'};
  const ctx={locale:{register:()=>{},bind:()=>key=>key},remote:{browserFlock:{dispatch:async request=>{calls.push(request);return {ok:true,value:{ok:true,data:request.action==='get_browser_flock_snapshot'?snapshot:{}}};}}}};
  const Page=createPage(React,ctx);const render=()=>{si=0;ri=0;return Page();};
  const nodes=node=>!node||typeof node!=='object'?[]:[node,...node.children.flatMap(nodes)];
  render();const cleanup=effects[0]();await new Promise(resolve=>setImmediate(resolve));
  try {
    let tree=render();nodes(tree).find(n=>n.props.className==='bf-runtime').props.onClick();
    assert.equal(calls.filter(c=>c.action==='open_browser_instance').length,0);
    tree=render();const select=nodes(tree).find(n=>n.type==='select'&&n.children.some(c=>c?.props?.value==='capture'));
    assert.ok(select);assert.equal(select.props.value,'system');select.props.onChange({target:{value:'capture'}});
    const presetState=states.indexOf(snapshot.proxy_presets);assert.ok(presetState>=0);states[presetState]=[];
    tree=render();assert.ok(nodes(tree).find(n=>n.type==='option'&&n.props.value==='capture').props.disabled);
    assert.ok(nodes(tree).find(n=>n.type==='button'&&n.props.type==='submit').props.disabled);
    await nodes(tree).find(n=>n.type==='form').props.onSubmit({preventDefault(){}});
    assert.equal(calls.filter(c=>c.action==='open_browser_instance').length,0,'stale preset must not launch even with programmatic submit');
    tree=render();assert.ok(nodes(tree).some(n=>n.children.includes('proxyMissing')));
    states[presetState]=snapshot.proxy_presets;tree=render();assert.equal(nodes(tree).find(n=>n.type==='button'&&n.props.type==='submit').props.disabled,false);
    await nodes(tree).find(n=>n.type==='form').props.onSubmit({preventDefault(){}});
    assert.deepEqual(calls.find(c=>c.action==='open_browser_instance').args,{runtime_id:'chrome',mode:'persistent',proxy_preset_id:'capture'});
    tree=render();nodes(tree).find(n=>n.type==='button'&&n.children.includes('proxies')).props.onClick();tree=render();
    assert.ok(nodes(tree).some(n=>n.type==='h3'&&n.children.includes('Capture')));
    assert.ok(!nodes(tree).some(n=>n.props.className==='bf-view-buttons'));
    nodes(tree).find(n=>n.type==='button'&&n.children.includes('proxyEdit')).props.onClick();tree=render();
    await nodes(tree).find(n=>n.type==='form').props.onSubmit({preventDefault(){}});
    assert.deepEqual(calls.find(c=>c.action==='save_browser_proxy_preset').args,{preset_id:'capture',name:'Capture',proxy:{mode:'http',host:'127.0.0.1',port:8888}});
    tree=render();nodes(tree).find(n=>n.type==='button'&&n.children.includes('proxyDelete')).props.onClick();tree=render();
    assert.ok(nodes(tree).some(n=>n.type==='h2'&&n.children.includes('proxyDeleteTitle')));
    await nodes(tree).find(n=>n.type==='form').props.onSubmit({preventDefault(){}});
    assert.deepEqual(calls.find(c=>c.action==='delete_browser_proxy_preset').args,{preset_id:'capture'});
  } finally {cleanup();}
});

test('Extension center scans, captures and queues installation only into eligible instances',async(t)=>{
  const states=[],refs=[],effects=[],calls=[];let si=0,ri=0;
  const React={createElement:(type,props,...children)=>({type,props:props||{},children:children.flat(Infinity)}),Fragment:'fragment',useState:value=>{const i=si++;if(!(i in states))states[i]=value;return [states[i],next=>states[i]=typeof next==='function'?next(states[i]):next];},useRef:value=>{const i=ri++;return refs[i] ||= {current:value};},useEffect:fn=>effects.push(fn),useSyncExternalStore:()=>{}};
  const entry={id:'lib',extension_id:'abc',name:'Example',version:'1',browser:'chrome',permissions:['storage'],host_permissions:['https://example.com/*'],id_preserved:false};
  const snapshot={runtimes:[{id:'cr',browser:'chrome',available:true},{id:'ff',browser:'firefox',available:true}],instances:[{id:'source',name:'Source',runtimeId:'cr',status:'running',mode:'persistent',cdpEnabled:true},{id:'target',name:'Target',runtimeId:'cr',status:'stopped',mode:'persistent'},{id:'unsupported',runtimeId:'ff',status:'stopped',mode:'persistent'},{id:'nocdp',runtimeId:'cr',status:'running',mode:'persistent',cdpEnabled:false},{id:'failed',runtimeId:'cr',status:'error',mode:'persistent'},{id:'temporary',runtimeId:'cr',status:'stopped',mode:'ephemeral'}],extension_library:[entry]};
  const ctx={locale:{register:()=>{},bind:()=>key=>key},remote:{browserFlock:{dispatch:async request=>{calls.push(request);return {ok:true,value:{ok:true,data:request.action==='get_browser_flock_snapshot'?snapshot:request.action==='list_instance_extensions'?{items:[{...entry,source_profile:'Default'}]}:request.action==='install_browser_extension'?{status:'queued'}:request.action==='capture_browser_extension'?entry:{}}};}}}};
  const Page=createPage(React,ctx),render=()=>{si=0;ri=0;return Page();},nodes=node=>!node||typeof node!=='object'?[]:[node,...node.children.flatMap(nodes)];
  const click=(tree,label)=>nodes(tree).find(n=>n.type==='button'&&n.children.includes(label)).props.onClick();
  render();const cleanup=effects[0]();await new Promise(resolve=>setImmediate(resolve));
  try {
    click(render(),'extensions');let tree=render();assert.ok(!nodes(tree).some(n=>n.type==='option'&&n.props.value==='unsupported'));
    nodes(tree).find(n=>n.type==='select').props.onChange({target:{value:'source'}});await click(render(),'extensionScan');
    await click(render(),'extensionCapture');assert.deepEqual(calls.find(c=>c.action==='capture_browser_extension').args,{instance_id:'source',extension_id:'abc',source_profile:'Default'});
    assert.ok(nodes(render()).find(n=>n.type==='button'&&n.children.includes('extensionCollected')).props.disabled);
    click(render(),'extensionInstall');tree=render();const modal=nodes(tree).find(n=>n.type==='form');
    assert.ok(nodes(modal).some(n=>n.children.includes('extensionIdHint')));assert.ok(nodes(modal).some(n=>n.children.includes('storage, https://example.com/*')));
    assert.ok(!nodes(modal).some(n=>n.type==='option'&&['unsupported','nocdp','failed','temporary'].includes(n.props.value)));
    await modal.props.onSubmit({preventDefault(){}});assert.ok(!calls.some(c=>c.action==='install_browser_extension'));
    nodes(render()).find(n=>n.type==='form').children.flatMap(nodes).find(n=>n.type==='select').props.onChange({target:{value:'target'}});
    await nodes(render()).find(n=>n.type==='form').props.onSubmit({preventDefault(){}});
    assert.deepEqual(calls.find(c=>c.action==='install_browser_extension').args,{instance_id:'target',library_id:'lib'});
    assert.ok(nodes(render()).some(n=>n.props.role==='status'&&nodes(n).some(child=>child.children.includes('extensionQueued'))));
    t.mock.timers.enable({apis:['setTimeout']});effects.length=0;render();const clearNotice=effects[2]();
    t.mock.timers.tick(3999);assert.ok(nodes(render()).some(n=>n.props.role==='status'&&nodes(n).some(child=>child.children.includes('extensionQueued'))));
    t.mock.timers.tick(1);assert.ok(!nodes(render()).some(n=>n.props.role==='status'&&nodes(n).some(child=>child.children.includes('extensionQueued'))));clearNotice();t.mock.timers.reset();
    click(render(),'instances');click(render(),'create');tree=render();
    const runtimeSelect=nodes(tree).find(n=>n.type==='select'&&n.children.some(c=>c?.props?.value==='cr'));
    runtimeSelect.props.onChange({target:{value:'cr'}});tree=render();
    assert.ok(nodes(tree).some(n=>n.children.includes('storage, https://example.com/*')));
    nodes(tree).find(n=>n.type==='input'&&n.props.type==='checkbox').props.onChange({target:{checked:true}});
    await nodes(render()).find(n=>n.type==='form').props.onSubmit({preventDefault(){}});
    assert.deepEqual(calls.find(c=>c.action==='open_browser_instance').args.extension_library_ids,['lib']);
  }finally{cleanup();}
});

test('Extension details enforce stopped persistent removal and library deletion preserves Host errors',async()=>{
  const states=[],refs=[],effects=[],calls=[];let si=0,ri=0;
  const React={createElement:(type,props,...children)=>({type,props:props||{},children:children.flat(Infinity)}),Fragment:'fragment',useState:value=>{const i=si++;if(!(i in states))states[i]=value;return [states[i],next=>states[i]=typeof next==='function'?next(states[i]):next];},useRef:value=>{const i=ri++;return refs[i] ||= {current:value};},useEffect:fn=>effects.push(fn),useSyncExternalStore:()=>{}};
  const entry={id:'lib',name:'Example',version:'1',browser:'chrome'};
  const instance={id:'target',name:'Target',runtimeId:'cr',status:'running',mode:'persistent',extensionLibraryIds:['lib'],extensionPackages:{lib:{entry:{name:'Independent copy'}}},extensionLoadResults:[{library_id:'lib',status:'queued'}]};
  const snapshot={runtimes:[{id:'cr',browser:'chrome',available:true}],instances:[instance],extension_library:[entry]};let rejectDelete=true;
  const ctx={locale:{register:()=>{},bind:()=>key=>key},remote:{browserFlock:{dispatch:async request=>{
    calls.push(request);
    if(request.action==='remove_browser_extension' && rejectDelete)return {ok:true,value:{ok:false,error:{message:'Instance copy could not be preserved'}}};
    if(request.action==='remove_instance_extension'){instance.extensionLibraryIds=[];instance.extensionLoadResults=[];}
    if(request.action==='remove_browser_extension')snapshot.extension_library=[];
    return {ok:true,value:{ok:true,data:request.action==='get_browser_flock_snapshot'?snapshot:{instance}}};
  }}}};
  const Page=createPage(React,ctx),render=()=>{si=0;ri=0;return Page();},nodes=node=>!node||typeof node!=='object'?[]:[node,...node.children.flatMap(nodes)];
  const findButton=(tree,label)=>nodes(tree).find(n=>n.type==='button'&&(n.props['aria-label']===label||n.children.includes(label)));
  render();const cleanup=effects[0]();await new Promise(resolve=>setImmediate(resolve));
  try {
    nodes(render()).find(n=>n.props.className==='bf-instance-select').props.onClick({currentTarget:{}});
    let tree=render();assert.ok(nodes(tree).some(n=>n.props.role==='status'&&n.children.includes('extensionStatus_queued')));
    assert.ok(nodes(tree).some(n=>n.children.includes('Independent copy')),'instance copy metadata supplies its own name');
    assert.equal(findButton(tree,'extensionRemove').props.disabled,true);
    await findButton(tree,'extensionRemove').props.onClick();assert.ok(!calls.some(c=>c.action==='remove_instance_extension'));
    instance.status='stopped';instance.mode='ephemeral';tree=render();assert.equal(findButton(tree,'extensionRemove').props.disabled,true);
    instance.mode='persistent';tree=render();assert.equal(findButton(tree,'extensionRemove').props.disabled,false);
    await findButton(tree,'extensionRemove').props.onClick();assert.ok(!calls.some(c=>c.action==='remove_instance_extension'),'uninstall requires confirmation');
    await nodes(render()).find(n=>n.type==='form').props.onSubmit({preventDefault(){}});assert.deepEqual(calls.find(c=>c.action==='remove_instance_extension').args,{instance_id:'target',library_id:'lib'});
    assert.ok(!findButton(render(),'extensionRemove'));
    findButton(render(),'extensions').props.onClick();findButton(render(),'extensionDelete').props.onClick();
    await nodes(render()).find(n=>n.type==='form').props.onSubmit({preventDefault(){}});
    assert.ok(nodes(render()).some(n=>n.props.role==='alert'&&nodes(n).some(child=>child.children.includes('Instance copy could not be preserved'))));
    assert.ok(nodes(render()).some(n=>n.type==='form'),'failed deletion keeps the dialog open');
    rejectDelete=false;await nodes(render()).find(n=>n.type==='form').props.onSubmit({preventDefault(){}});
    assert.deepEqual(calls.find(c=>c.action==='remove_browser_extension').args,{library_id:'lib'});
    assert.ok(!nodes(render()).some(n=>n.type==='form'));assert.ok(!findButton(render(),'extensionDelete'));
  }finally{cleanup();}
});

test('snapshot notices distinguish cached checks in progress from stale or failed refresh',()=>{
  assert.equal(snapshotNotice(null),'snapshotUpdating');
  for(const state of ['updating','current','updating','current']) {
    assert.equal(snapshotNotice({runtimes:{state,last_checked_at:'2026-10-21T00:00:00Z'},instances:{state,last_checked_at:'2026-10-21T00:00:00Z'}}),null,'regular refresh must not toggle a layout banner');
  }
  assert.equal(snapshotNotice({runtimes:{state:'current'},instances:{state:'updating'}}),'snapshotUpdating');
  assert.equal(snapshotNotice({runtimes:{state:'stale'},instances:{state:'current'}}),'snapshotStale');
  assert.equal(snapshotNotice({runtimes:{state:'current'},instances:{state:'error'}}),'snapshotStale');
  assert.equal(snapshotNotice({runtimes:{state:'current'},instances:{state:'current'}}),null);
});

test('CDP addresses invalidate on instance selection, lifecycle, identity, or pending mutation, not routine timestamps',()=>{
  const item={id:'work',status:'running',cdpEnabled:true,processIdentity:{pid:42,startTime:'one'},updatedAt:'old'};
  const key=cdpInstanceKey(item);
  assert.equal(cdpInstanceKey({...item,updatedAt:'new'}),key);
  for(const change of [{id:'other'},{status:'stopped'},{cdpEnabled:false},{processIdentity:{pid:42,startTime:'two'}},{lastOpenedAt:'new'}])assert.notEqual(cdpInstanceKey({...item,...change}),key);
  assert.notEqual(cdpInstanceKey(item,'stopping'),key);assert.equal(cdpInstanceKey(null),null);
});

const deferred = () => {let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};

test('Client preserves transport and business RPC errors, and returns business data',async()=>{
  const seen=[];let response={ok:true,value:{ok:true,data:{instance:{id:'a',status:'running'}}}};
  const rpc=createClientRpc({remote:{browserFlock:{dispatch:async request=>{seen.push(request);return response;}}}});
  assert.deepEqual(await rpc('open_browser_instance',{runtime_id:'rt'}),response.value.data);
  assert.deepEqual(seen,[{action:'open_browser_instance',args:{runtime_id:'rt'}}]);
  const transport={code:'DISCONNECTED',message:'Lost connection'};response={ok:false,error:transport};
  await assert.rejects(rpc('list_browser_instances'),error=>error===transport);
  const business={code:'CLOSE_TIMEOUT',message:'Still running',recovery_hint:'Try again'};response={ok:true,value:{ok:false,error:business}};
  await assert.rejects(rpc('close_browser_instance'),error=>error===business);
});

test('instance responses reconcile wrapped creation, direct rename and deleted tombstones',()=>{
  const initial=[{id:'a',name:'Work',status:'running'},{id:'b',name:'Test',status:'stopped'}];
  const renamed=reconcileInstanceResult(initial,{id:'a',name:'Work 2',status:'running'});
  assert.equal(renamed[0].name,'Work 2');assert.equal(initial[0].name,'Work');
  const created=reconcileInstanceResult(initial,{instance:{id:'c',status:'running'},created:true});
  assert.deepEqual(created.map(x=>x.id),['c','a','b']);
  assert.deepEqual(reconcileInstanceResult(initial,{instance:{id:'a',status:'deleted'},data_retained:false}).map(x=>x.id),['b']);
  assert.equal(reconcileInstanceResult(initial,{ok:true}),initial);
});

test('search and filters use browser metadata and pending close state',()=>{
  const items=[{id:'a',name:'Work',runtimeId:'edge',status:'running'},{id:'b',name:'Test',runtimeId:'chrome',status:'stopped'}];
  const runtimes=[{id:'edge',name:'Microsoft Edge',browser:'edge'},{id:'chrome',name:'Chrome',browser:'chrome'}];
  assert.deepEqual(filterInstances(items,' EDGE ','all',runtimes).map(i=>i.id),['a']);
  assert.deepEqual(filterInstances(items,'work','running',runtimes,{a:'stopping'}),[]);
  assert.deepEqual(filterInstances(items,'','stopped',runtimes,{a:'stopping'}).map(i=>i.id),['b']);
  assert.equal(filterInstances(items,'','all',runtimes,{a:'stopping'}).length,2);
});

test('close remains pending until Host reply and instance refresh; no premature completed state',async()=>{
  const response=deferred(), refresh=deferred(),events=[];
  const task=performInstanceMutation(async(action,args)=>{events.push([action,args]);return response.promise;},'close_browser_instance',{instance_id:'a'}, {
    onResult:data=>events.push(['result',data]),onError:error=>events.push(['error',error]),refresh:()=>{events.push(['refresh-instances']);return refresh.promise;},finish:()=>events.push(['finish'])
  });
  assert.deepEqual(events,[['close_browser_instance',{instance_id:'a'}]]);
  response.resolve({instance:{id:'a',status:'stopped'}});await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(events.map(x=>x[0]),['close_browser_instance','result','refresh-instances']);
  refresh.resolve();await task;assert.equal(events.at(-1)[0],'finish');
});

test('failed close reports Host error and refreshes actual state instead of fabricating stopped',async()=>{
  const error={code:'CLOSE_TIMEOUT',message:'Browser did not exit'};const events=[];
  await performInstanceMutation(async()=>{throw error;},'close_browser_instance',{instance_id:'a'}, {
    onResult:()=>events.push('result'),onError:value=>{assert.equal(value,error);events.push('error');},refresh:async()=>events.push('refresh-instances'),finish:()=>events.push('finish')
  });
  assert.deepEqual(events,['error','refresh-instances','finish']);
});

test('Chinese and English expose identical interface labels with Browser Flock title',()=>{
  assert.deepEqual(Object.keys(pageDictionaries.en).sort(),Object.keys(pageDictionaries.zh).sort());
  assert.equal(pageDictionaries.zh.title,'浏览器群');
  assert.equal(pageDictionaries.en.title,'Browser Flock');
});


test('Recording controls gate eligibility, stop across tabs, preserve errors and page events',async()=>{
  const states=[],refs=[],effects=[],calls=[];let si=0,ri=0,rejectStop=false,rejectDelete=true,resolveDelete;
  const React={createElement:(type,props,...children)=>({type,props:props||{},children:children.flat(Infinity)}),Fragment:'fragment',useState:value=>{const i=si++;if(!(i in states))states[i]=value;return [states[i],next=>states[i]=typeof next==='function'?next(states[i]):next];},useRef:value=>{const i=ri++;return refs[i] ||= {current:value};},useEffect:fn=>effects.push(fn),useSyncExternalStore:()=>{}};
  const instance={id:'target',name:'Target',runtimeId:'cr',status:'stopped',mode:'persistent',cdpEnabled:true};
  const snapshot={runtimes:[{id:'cr',browser:'chrome',available:true}],instances:[instance],recordings:[]};
  const record={id:'rec',instance_id:'target',instance_name:'Target',name:'Manual session',status:'recording',started_at:'2026-10-21T09:00:00Z',event_count:2,request_count:1};
  const ctx={locale:{register:()=>{},bind:()=>key=>key},remote:{browserFlock:{dispatch:async request=>{
    calls.push(request);let data;
    if(request.action==='get_browser_flock_snapshot')data=snapshot;
    if(request.action==='start_browser_recording'){snapshot.recordings=[record];data=record;}
    if(request.action==='stop_browser_recording'){if(rejectStop)return {ok:true,value:{ok:false,error:{message:'Stop failed'}}};record.status='stopped';data=record;}
    if(request.action==='delete_browser_recording'){if(rejectDelete)return {ok:true,value:{ok:false,error:{message:'Delete failed'}}};await new Promise(resolve=>resolveDelete=resolve);data={recording_id:request.args.recording_id,deleted:true};}
    if(request.action==='list_browser_recordings')data={items:[record],next_offset:null};
    if(request.action==='list_browser_recording_events')data={items:[{id:String(request.args.offset),type:'click',time:'2026-10-21T09:00:00Z',data:{value:'full input'}}],next_offset:request.args.offset?null:50};
    return {ok:true,value:{ok:true,data:data||{}}};
  }}}};
  const Page=createPage(React,ctx),render=()=>{si=0;ri=0;return Page();},nodes=node=>!node||typeof node!=='object'?[]:[node,...node.children.flatMap(nodes)];
  const button=(tree,key)=>nodes(tree).find(n=>n.type==='button'&&(n.props['aria-label']===key||n.children.includes(key)));
  render();const cleanup=effects[0]();await new Promise(resolve=>setImmediate(resolve));
  try {
    nodes(render()).find(n=>n.props.className==='bf-instance-select').props.onClick({currentTarget:{}});
    assert.equal(button(render(),'recordingStart').props.disabled,true);
    await button(render(),'recordingStart').props.onClick();assert.ok(!calls.some(c=>c.action==='start_browser_recording'));
    instance.status='running';instance.cdpEnabled=false;assert.equal(button(render(),'recordingStart').props.disabled,true);
    instance.cdpEnabled=true;snapshot.runtimes[0].browser='firefox';assert.equal(button(render(),'recordingStart').props.disabled,true);
    snapshot.runtimes[0].browser='chrome';assert.equal(button(render(),'recordingStart').props.disabled,false);
    const start=button(render(),'recordingStart');await Promise.all([start.props.onClick(),start.props.onClick()]);
    assert.equal(calls.filter(c=>c.action==='start_browser_recording').length,1);assert.deepEqual(calls.find(c=>c.action==='start_browser_recording').args,{instance_id:'target'});
    button(render(),'extensions').props.onClick();assert.ok(button(render(),'recordingStop'),'stop remains visible on other tabs');
    rejectStop=true;await button(render(),'recordingStop').props.onClick();assert.ok(button(render(),'recordingStop'));assert.ok(nodes(render()).some(n=>n.children.includes('Stop failed')));
    button(render(),'recordings').props.onClick();await new Promise(resolve=>setImmediate(resolve));assert.ok(!button(render(),'recordingDelete'),'active recording has no delete action');
    rejectStop=false;await button(render(),'recordingStop').props.onClick();assert.ok(!button(render(),'recordingStop'));
    button(render(),'recordings').props.onClick();await new Promise(resolve=>setImmediate(resolve));
    assert.ok(calls.some(c=>c.action==='list_browser_recordings'));await button(render(),'recordingView').props.onClick();
    assert.ok(nodes(render()).some(n=>n.type==='pre'&&n.children.some(v=>typeof v==='string'&&v.includes('full input'))));
    await button(render(),'recordingMore').props.onClick();assert.equal(nodes(render()).filter(n=>n.type==='details').length,2);assert.equal(calls.filter(c=>c.action==='list_browser_recording_events').at(-1).args.offset,50);
    assert.ok(!nodes(render()).some(n=>n.type==='button'&&n.children.some(v=>typeof v==='string'&&/analysis|分析/i.test(v))));
    assert.ok(nodes(render()).some(n=>n.type==='span'&&n.children.includes(formatRecordingTime('2026-10-21T09:00:00Z'))));
    button(render(),'recordingDelete').props.onClick();assert.ok(!calls.some(c=>c.action==='delete_browser_recording'));
    assert.ok(nodes(render()).some(n=>n.children.includes('recordingDeleteTitle')));
    button(render(),'cancel').props.onClick();assert.ok(!calls.some(c=>c.action==='delete_browser_recording'));
    record.status='interrupted';button(render(),'recordingDelete').props.onClick();await nodes(render()).find(n=>n.type==='form').props.onSubmit({preventDefault(){}});
    assert.ok(nodes(render()).some(n=>n.children.includes('Delete failed')));assert.ok(nodes(render()).some(n=>n.props.className==='bf-recording-card'));
    rejectDelete=false;const submit=nodes(render()).find(n=>n.type==='form').props.onSubmit;
    const pending=submit({preventDefault(){}});await submit({preventDefault(){}});
    assert.equal(calls.filter(c=>c.action==='delete_browser_recording').length,2,'duplicate submit locked');
    assert.equal(button(render(),'cancel').props.disabled,true);resolveDelete();await pending;
    assert.deepEqual(calls.filter(c=>c.action==='delete_browser_recording').at(-1).args,{recording_id:'rec'});
    assert.ok(!nodes(render()).some(n=>n.props.className==='bf-recording-card'||n.props.className==='bf-recording-timeline'));
    await button(render(),'recordingRefresh').props.onClick();assert.ok(!nodes(render()).some(n=>n.props.className==='bf-recording-card'),'stale list response must not resurrect deletion');
  } finally {cleanup?.();}
});

test('Recording refresh has pending, success and failure feedback with compact readable event rows',async()=>{
  const states=[],refs=[],effects=[];let si=0,ri=0,pending=null,fail=false;
  const React={createElement:(type,props,...children)=>({type,props:props||{},children:children.flat(Infinity)}),Fragment:'fragment',useState:value=>{const i=si++;if(!(i in states))states[i]=value;return [states[i],next=>states[i]=typeof next==='function'?next(states[i]):next];},useRef:value=>refs[ri++] ||= {current:value},useEffect:fn=>effects.push(fn),useSyncExternalStore:()=>{}};
  const record={id:'r',name:'Session',status:'recording',started_at:'2026-10-21T09:00:00Z'},url='https://example.com/'+ 'long/'.repeat(80);
  const ctx={locale:{register(){},bind:()=>key=>pageDictionaries.zh[key] || key},remote:{browserFlock:{dispatch:async({action})=>{if(pending && action==='list_browser_recordings')await pending.promise;if(fail && action.startsWith('list_'))throw {message:'Offline'};return {ok:true,value:{ok:true,data:action==='get_browser_flock_snapshot'?{instances:[],runtimes:[],recordings:[record]}:action==='list_browser_recordings'?{items:[record],total:1,next_offset:null}:{items:[{type:'http_request',time:record.started_at,url}],next_offset:null}}};}}}};
  const Page=createPage(React,ctx),render=()=>{si=0;ri=0;return Page();},nodes=n=>!n||typeof n!=='object'?[]:[n,...n.children.flatMap(nodes)],button=key=>nodes(render()).find(n=>n.type==='button'&&n.children.includes(pageDictionaries.zh[key]));
  render();const cleanup=effects[0]();await new Promise(r=>setImmediate(r));
  try {
    button('recordings').props.onClick();await new Promise(r=>setImmediate(r));
    pending=deferred();const refresh=button('recordingRefresh').props.onClick();assert.equal(button('recordingLoading').props.disabled,true);pending.resolve();await refresh;pending=null;
    assert.ok(nodes(render()).some(n=>n.props.role==='status'&&n.children.some(v=>typeof v==='string'&&v.includes('已更新'))));
    await button('recordingView').props.onClick();let tree=render();
    assert.ok(nodes(tree).some(n=>n.props.className==='bf-event-type'&&n.children.includes('请求')));
    assert.equal(nodes(tree).find(n=>n.props.className==='bf-event-url').props.title,url);
    assert.match(nodes(tree).find(n=>n.props.className==='bf-event-time').children[0],/^\d{2}:\d{2}:\d{2}$/);
    assert.ok(nodes(tree).some(n=>n.props.className==='bf-event-address'&&n.children.includes(url)));
    fail=true;await button('recordingEventRefresh').props.onClick();assert.ok(nodes(render()).some(n=>n.props.className==='bf-event-url'),'failed refresh retains events');
    assert.ok(nodes(render()).some(n=>n.props.role==='status'&&n.children.some(v=>typeof v==='string'&&v.includes('刷新失败')&&v.includes('Offline'))));
    fail=false;await button('recordingEventRefresh').props.onClick();record.status='stopped';assert.equal(button('recordingEventRefresh'),undefined);
    assert.ok(nodes(render()).some(n=>n.children.includes(pageDictionaries.zh.recordingSaved)));
  }finally{cleanup();}
});

 test('Recording timestamps use local zone and legacy names preserve custom text',()=>{
  const timestamp='2026-10-21T09:00:00.000Z';
  const local=formatRecordingTime(timestamp,'en-GB','Asia/Shanghai');
  assert.match(local,/17:00:00/);assert.match(local,/GMT\+8/);assert.ok(!local.includes(timestamp));
  assert.equal(formatRecordingTime('invalid'),'—');assert.equal(formatRecordingTime(null),'—');
  const record={id:'r',instance_name:'Admin',started_at:timestamp,name:'Admin '+timestamp};
  assert.equal(recordingDisplayName(record),'Admin');
  assert.equal(recordingDisplayName({...record,name:'Admin 2026-10-21T08:59:59.999Z'}),'Admin '+formatRecordingTime('2026-10-21T08:59:59.999Z'));
  assert.equal(recordingDisplayName({...record,name:'Custom '+timestamp}),'Custom '+timestamp);
  assert.equal(recordingDisplayName({...record,name:'Admin 2026-10-21T08:00:00.000Z'}),'Admin 2026-10-21T08:00:00.000Z');
});
