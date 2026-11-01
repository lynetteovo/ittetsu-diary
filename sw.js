// 推し活手帳 service worker：画面はキャッシュから即表示し、裏で新しい版を取りに行く
const SHELL='shell-v3';
const FONTS='fonts-v1';
const FILES=['./','./index.html','./manifest.json','./icon.png'];

self.addEventListener('install',e=>{
  e.waitUntil(caches.open(SHELL).then(c=>c.addAll(FILES.map(f=>new Request(f,{cache:'reload'})))).then(()=>self.skipWaiting()));
});

self.addEventListener('activate',e=>{
  e.waitUntil(caches.keys()
    .then(ks=>Promise.all(ks.filter(k=>k!==SHELL&&k!==FONTS).map(k=>caches.delete(k))))
    .then(()=>self.clients.claim()));
});

self.addEventListener('fetch',e=>{
  const req=e.request;
  if(req.method!=='GET')return;
  const url=new URL(req.url);
  if(url.origin===location.origin){
    // 配信データ・カレンダーは毎回ネットワーク（ページ側で失敗時は前回の内容のまま）
    if(/\/streams\.(json|ics)$/.test(url.pathname))return;
    if(/\/(index\.html)?$/.test(url.pathname)){e.respondWith(page(e));return;}
    e.respondWith(caches.open(SHELL).then(c=>c.match(req).then(hit=>{
      const net=fetch(req).then(res=>{if(res.ok)c.put(req,res.clone());return res;});
      if(hit){e.waitUntil(net.catch(()=>{}));return hit;}
      return net;
    })));
    return;
  }
  if(url.host==='fonts.googleapis.com'||url.host==='fonts.gstatic.com'){
    e.respondWith(caches.open(FONTS).then(c=>c.match(req).then(hit=>hit||fetch(req).then(res=>{
      if(res.ok||res.type==='opaque')c.put(req,res.clone());
      return res;
    }))));
  }
});

// index.html：キャッシュを即返す → 裏で取得 → 中身が変わっていたらページに知らせる
async function page(e){
  const c=await caches.open(SHELL);
  const hit=await c.match('./index.html');
  const prev=hit?hit.clone():null;   // hit 本体はページに渡すので先に複製
  const net=fetch('./index.html',{cache:'no-cache'}).then(async res=>{
    if(!res.ok)return res;
    const fresh=await res.clone().text();
    const old=prev?await prev.text():null;
    await c.put('./index.html',res.clone());
    if(old!==null&&old!==fresh){
      const cl=await self.clients.matchAll({type:'window',includeUncontrolled:true});
      cl.forEach(x=>x.postMessage('updated'));
    }
    return res;
  });
  if(hit){e.waitUntil(net.catch(()=>{}));return hit;}
  return net.catch(()=>Response.error());
}
