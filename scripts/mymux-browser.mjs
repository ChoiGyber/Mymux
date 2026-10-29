// Control the visible Mymux native browser from a local terminal (Node 22+).
// node "$env:MYMUX_BROWSER_CONTROL" snapshot
// node "$env:MYMUX_BROWSER_CONTROL" navigate https://example.com
// node "$env:MYMUX_BROWSER_CONTROL" fill '#search' 'hello'
import { pathToFileURL } from 'node:url';

export function isBrowserTarget(target) {
  if (target.type !== 'page') return false;
  try {
    const url = new URL(target.url);
    return ['http:', 'https:'].includes(url.protocol) &&
      !['tauri.localhost', 'localhost.tauri'].includes(url.hostname);
  } catch { return false; }
}

export function actionExpression(action, args) {
  const literal = value => JSON.stringify(value ?? '');
  switch (action) {
    case 'snapshot': return `JSON.stringify({url:location.href,title:document.title,text:document.body?.innerText?.slice(0,40000),fields:[...document.querySelectorAll('input,textarea,select,button,a')].slice(0,150).map(e=>({tag:e.tagName,id:e.id,name:e.name,text:e.innerText?.slice(0,120),type:e.type,href:e.href}))})`;
    case 'click': return `(()=>{const e=document.querySelector(${literal(args[0])});if(!e)throw Error('Element not found');e.click();return true})()`;
    case 'fill': return `(()=>{const e=document.querySelector(${literal(args[0])});if(!e)throw Error('Element not found');const p=e instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;const set=Object.getOwnPropertyDescriptor(p,'value')?.set;if(!set)throw Error('Element is not a text input');set.call(e,${literal(args[1])});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return true})()`;
    case 'evaluate': if (!args[0]) throw Error('JavaScript expression required'); return args[0];
    default: throw Error('Actions: targets, snapshot, navigate URL, click SELECTOR, fill SELECTOR TEXT, evaluate JAVASCRIPT; optional --target ID');
  }
}

export async function run(argv = process.argv.slice(2)) {
  const endpoint = process.env.MYMUX_BROWSER_ENDPOINT;
  if (!endpoint) throw Error('Run this helper inside a local Mymux terminal after restarting the updated app.');
  const base = new URL(endpoint);
  if (base.hostname !== '127.0.0.1' || base.protocol !== 'http:') throw Error('Expected local Mymux endpoint');
  const response = await fetch(new URL('/json/list', base), { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw Error(`CDP target discovery failed (${response.status})`);
  const targets = (await response.json()).filter(isBrowserTarget);
  const action = argv.shift() || 'snapshot';
  const targetFlag = argv.indexOf('--target');
  const targetId = targetFlag < 0 ? null : argv.splice(targetFlag, 2)[1];
  if (action === 'targets') return targets.map(({id,title,url})=>({id,title,url}));
  const matches = targets.filter(t => !targetId || t.id === targetId);
  if (matches.length !== 1) throw Error(matches.length ? 'Several browser pages are open; run targets, then use --target ID.' : 'Open a website in the Mymux browser first.');
  if (typeof WebSocket !== 'function') throw Error('Node 22 or newer is required.');
  const target = matches[0];
  const wsUrl = new URL(target.webSocketDebuggerUrl);
  if (!['127.0.0.1','localhost'].includes(wsUrl.hostname) || wsUrl.port !== base.port) throw Error('Unexpected CDP WebSocket endpoint');
  const ws = new WebSocket(wsUrl);
  try {
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('CDP connection timeout')),5000);
      ws.addEventListener('open',()=>{clearTimeout(timer);resolve()}, {once:true});
      ws.addEventListener('error',()=>{clearTimeout(timer);reject(Error('CDP connection failed'))}, {once:true});
    });
    let method = 'Runtime.evaluate';
    let params = { expression: action === 'navigate' ? 'undefined' : actionExpression(action, argv), returnByValue: true, awaitPromise: true };
    if (action === 'navigate') {
      const url = new URL(argv[0]);
      if (!['http:','https:'].includes(url.protocol)) throw Error('Only HTTP/HTTPS navigation is allowed');
      method = 'Page.navigate'; params = {url:url.href};
    }
    return await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('CDP command timeout')),15000);
      ws.addEventListener('message',event=>{
        const msg=JSON.parse(event.data);if(msg.id!==1)return;
        clearTimeout(timer);
        if(msg.error || msg.result?.exceptionDetails) reject(Error(JSON.stringify(msg.error || msg.result.exceptionDetails)));
        else if(msg.result?.errorText) reject(Error(msg.result.errorText));
        else resolve(msg.result?.result?.value ?? msg.result);
      });
      ws.send(JSON.stringify({id:1,method,params}));
    });
  } finally { ws.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().then(result=>console.log(typeof result==='string'?result:JSON.stringify(result,null,2))).catch(error=>{console.error(error.message);process.exitCode=1});
}
