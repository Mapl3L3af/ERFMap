/* Preview the isolated frontend, forwarding APIs to the normal erfMap server. */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = __dirname;
const backend = new URL(process.env.ERFMAP_BACKEND || 'http://127.0.0.1:3000');
const mime = {'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.json':'application/json','.jpg':'image/jpeg','.png':'image/png'};
http.createServer((req,res)=>{
  const pathname = new URL(req.url,'http://localhost').pathname;
  if(pathname.startsWith('/api/') || pathname.startsWith('/uploads/')){
    const proxy=http.request(new URL(req.url,backend),{method:req.method,headers:req.headers},r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res);});
    proxy.on('error',()=>{if(!res.headersSent)res.writeHead(503,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'Start the erfMap backend on port 3000 to use processing and saved projects.'}));});
    req.on('aborted',()=>proxy.destroy());res.on('close',()=>proxy.destroy());req.pipe(proxy);return;
  }
  let file;
  try{
    const decoded=decodeURIComponent(pathname);
    const route=decoded.replace(/^\/intake(?=\/|$)/,'/erfmap-intake').replace(/^\/survey(?=\/|$)/,'/erfmap-survey');
    file=path.resolve(root,'.'+(route==='/'?'/erfmap-frontpage/index.html':route==='/info.html'?'/erfmap-frontpage/info.html':route));
    if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}
    if(fs.existsSync(file)&&fs.statSync(file).isDirectory()){
      if(!pathname.endsWith('/')){res.writeHead(302,{Location:pathname+'/'+new URL(req.url,'http://localhost').search}).end();return;}
      file=path.join(file,'index.html');
    }
    // Launch page assets are requested from the root route.
    if(!fs.existsSync(file)&&!decoded.slice(1).includes('/'))file=path.join(root,'erfmap-frontpage',path.basename(decoded));
    fs.readFile(file,(err,data)=>{if(err){res.writeHead(404).end('Not found');return;}res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream','Cache-Control':'no-cache'});res.end(data);});
  }catch{res.writeHead(400).end('Invalid path');}
}).listen(Number(process.env.FRONTEND_PORT||3100),'127.0.0.1',()=>console.log('Frontend preview: http://127.0.0.1:'+(process.env.FRONTEND_PORT||3100)));
