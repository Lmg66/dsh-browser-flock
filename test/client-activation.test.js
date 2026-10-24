import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

test('built client renders and loads data only inside remote service injection',async()=>{
  let plugin, mounted=false; const calls=[],effects=[],registrations=[];
  const React={createElement:(type,props,...children)=>({type,props,children}),Fragment:'fragment',useState:value=>[value,()=>{}],useRef:value=>({current:value}),useEffect:fn=>effects.push(fn),useSyncExternalStore:()=>{}};
  const slots={inject:(_name,fn)=>fn(),register:(options,view)=>registrations.push({options,view})};
  const locale={register:()=>{},bind:()=>key=>key,subscribe:()=>()=>{},getSnapshot:()=> 'zh'};
  const remote={$mount:async()=>{mounted=true;}};
  Object.defineProperty(remote,'browserFlock',{get(){throw Error('remote.browserFlock accessed without inject');}});
  const scoped={slots,locale,remote:{browserFlock:{dispatch:async request=>{calls.push(request);return {ok:true,value:{ok:true,data:{instances:[],runtimes:[],default_runtime_id:null,freshness:{runtimes:{state:'pending'},instances:{state:'pending'}}}}};}}}};
  const ctx={slots,locale,remote,inject:(keys,fn)=>{assert.equal(mounted,true);assert.deepEqual(Array.from(keys),['remote.browserFlock']);fn(scoped);}};
  vm.runInNewContext(await readFile(new URL('../client.js',import.meta.url),'utf8'),{window:{__ModuleLoader__:{load:module=>{plugin=module.factory(()=>React);}}}});
  await plugin.apply(ctx);
  const page=registrations.find(item=>item.options.name==='main').view();
  assert.equal(page.props.className,'bf-page');
  assert.equal(page.children[1].props.className,'bf-content');
  effects[0]();
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(calls.map(call=>call.action).sort(),['get_browser_flock_snapshot']);
});
