import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {isBrowserTarget, actionExpression, run} from './mymux-browser.mjs';

test('target selection excludes app UI, overlay and workers but keeps local websites',()=>{
  for (const url of ['http://tauri.localhost/','https://tauri.localhost/overlay.html','tauri://localhost/','file:///app.html','about:blank']) assert.equal(isBrowserTarget({type:'page',url}),false,url);
  assert.equal(isBrowserTarget({type:'service_worker',url:'https://example.com/'}),false);
  for (const url of ['http://localhost:3000/','http://127.0.0.1:8080/','https://example.com/']) assert.equal(isBrowserTarget({type:'page',url}),true,url);
});

test('control helper connects to the selected native page and sends CDP actions',async()=>{
  const sent=[];
  const nativeWebSocket=globalThis.WebSocket;
  const inheritedEndpoint=process.env.MYMUX_BROWSER_ENDPOINT;
  let pages=[];
  const server=createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(pages));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port;
  process.env.MYMUX_BROWSER_ENDPOINT=`http://127.0.0.1:${port}`;
  globalThis.WebSocket=class extends EventTarget {
    constructor(url){super();assert.equal(String(url),`ws://127.0.0.1:${port}/native-page`);queueMicrotask(()=>this.dispatchEvent(new Event('open')))}
    send(data){const msg=JSON.parse(data);sent.push(msg);queueMicrotask(()=>this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({id:msg.id,result:{result:{value:'native result'}}})})))}
    close(){}
  };
  try {
    pages=[{id:'app',type:'page',url:'http://tauri.localhost/'},{id:'native',type:'page',url:'http://localhost:3000/',webSocketDebuggerUrl:`ws://127.0.0.1:${port}/native-page`}];
    assert.deepEqual((await run(['targets'])).map(p=>p.id),['native']);
    assert.equal(await run(['snapshot']),'native result');
    assert.equal(sent.at(-1).method,'Runtime.evaluate');
    assert.match(sent.at(-1).params.expression,/document.body/);
    await run(['navigate','https://example.com/test']);
    assert.deepEqual(sent.at(-1).params,{url:'https://example.com/test'});
    assert.equal(sent.at(-1).method,'Page.navigate');
    await assert.rejects(()=>run(['navigate','javascript:alert(1)']),/Only HTTP/);
    pages.push({...pages[1],id:'second',url:'https://example.org/'});
    await assert.rejects(()=>run(['snapshot']),/Several browser pages/);
    assert.equal(await run(['snapshot','--target','native']),'native result');
    pages[1].webSocketDebuggerUrl='ws://evil.example/native';
    await assert.rejects(()=>run(['snapshot','--target','native']),/Unexpected CDP/);
  } finally {
    globalThis.WebSocket=nativeWebSocket;
    if(inheritedEndpoint===undefined)delete process.env.MYMUX_BROWSER_ENDPOINT;else process.env.MYMUX_BROWSER_ENDPOINT=inheritedEndpoint;
    await new Promise(resolve=>server.close(resolve));
  }
});

test('fill and click quote selectors and values as data',()=>{
  const selector='input[name="a"]'; const text='";globalThis.injected=true;//';
  const expression=actionExpression('fill',[selector,text]);
  assert.ok(expression.includes(JSON.stringify(selector)));
  assert.ok(expression.includes(JSON.stringify(text)));
  assert.match(actionExpression('click',[selector]),/Element not found/);
  assert.throws(()=>actionExpression('unsupported',[]),/Actions:/);
});
