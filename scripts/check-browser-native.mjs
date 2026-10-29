import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../crates/mycli-desktop/frontend/app.js',import.meta.url),'utf8');
const labels=source.slice(source.indexOf('const BROWSER_LABELS ='),source.indexOf('function initBrowserPanel()'));
const native=source.slice(source.indexOf('let nativePaneOpenPromise ='),source.indexOf('function scheduleSync()'));
const navigate=source.slice(source.indexOf('async function nativeNavigate(input)'),source.indexOf('// ── Session persistence'));
function harness(invoke){
  const nodes=new Map();
  const document={getElementById(id){if(!nodes.has(id))nodes.set(id,{value:'',hidden:false,dataset:{},textContent:'',focus(){},getBoundingClientRect(){return{x:0,y:60,width:900,height:600}}});return nodes.get(id)}};
  const context=vm.createContext({navigator:{language:'ko-KR'},document,URL,encodeURIComponent,invoke,toast(){},WebSocket:{OPEN:1},setBrowserMode(){},launchBrowser(){},cdpSend(){}});
  vm.runInContext('let nativeCurrentUrl="", nativePaneCreated=false, memoNativePaneHidden=false, browserTabActive=true, browserMode="native", cdpWs=null;',context);
  vm.runInContext(labels+native+navigate,context);
  return {context,nodes,run:expression=>vm.runInContext(expression,context)};
}
test('address bar accepts local development addresses, domains, search and rejects unsafe schemes',()=>{
  const h=harness(async()=>{});
  for(const [input,expected] of [['localhost:3000','http://localhost:3000/'],['127.0.0.1:8080/path','http://127.0.0.1:8080/path'],['[::1]:4000','http://[::1]:4000/'],['example.com/path','https://example.com/path'],['https://example.com','https://example.com/'],['한글 검색','https://www.google.com/search?q='+encodeURIComponent('한글 검색')]])assert.equal(h.run(`resolveBrowserInput(${JSON.stringify(input)})`),expected);
  assert.equal(h.run('resolveBrowserInput("  ")'),null);
  for(const input of ['javascript:alert(1)','file:///C:/test','data:text/html,test'])assert.throws(()=>h.run(`resolveBrowserInput(${JSON.stringify(input)})`));
  assert.equal(h.run('JSON.stringify(Object.keys(BROWSER_LABELS.ko).sort())'),h.run('JSON.stringify(Object.keys(BROWSER_LABELS.en).sort())'));
  assert.equal(h.run('JSON.stringify(Object.keys(BROWSER_LABELS.ja).sort())'),h.run('JSON.stringify(Object.keys(BROWSER_LABELS.zh).sort())'));
});
test('rapid first navigation creates exactly one native pane and the latest URL wins',async()=>{
  const calls=[];let finish;
  const h=harness(async(method,args)=>{calls.push([method,args]);if(method==='browser_pane_open')await new Promise(resolve=>finish=resolve)});
  const first=h.run('nativeNavigate("one.example")');
  const second=h.run('nativeNavigate("two.example")');
  assert.equal(calls.filter(c=>c[0]==='browser_pane_open').length,1);
  finish();await Promise.all([first,second]);
  assert.equal(calls.at(-1)[0],'browser_pane_navigate');
  assert.equal(calls.at(-1)[1].url,'https://two.example/');
  assert.equal(h.run('nativeCurrentUrl'),'https://two.example/');
  const before=calls.filter(c=>c[0]==='browser_pane_navigate').length;
  await h.run('openNativePane()');
  assert.equal(calls.filter(c=>c[0]==='browser_pane_navigate').length,before,'reopening retains the live page');
});
test('creation failure stays retryable and exposes error state',async()=>{
  let fail=true;const h=harness(async(method)=>{if(method==='browser_pane_open'&&fail)throw Error('WebView unavailable')});
  await h.run('nativeNavigate("example.com")');
  assert.equal(h.run('nativePaneCreated'),false);
  assert.equal(h.nodes.get('browser-placeholder').dataset.state,'error');
  assert.equal(h.nodes.get('browser-retry').hidden,false);
  fail=false;await h.run('nativeNavigate(nativeCurrentUrl)');
  assert.equal(h.run('nativePaneCreated'),true);
});
test('Home and tab changes during creation keep the native overlay hidden',async()=>{
  for(const action of ['showBrowserHome()','browserTabActive=false']){
    const calls=[];let finish;
    const h=harness(async(method)=>{calls.push(method);if(method==='browser_pane_open')await new Promise(resolve=>finish=resolve)});
    const navigation=h.run('nativeNavigate("example.com")');h.run(action);finish();await navigation;
    assert.equal(calls.at(-1),'browser_pane_hide');
  }
});
