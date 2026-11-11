import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import SQLiteStoreFactory from 'connect-sqlite3';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import helmet from 'helmet';
import QRCode from 'qrcode';
import http from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __dirname=path.dirname(fileURLToPath(import.meta.url));
const dataDir=process.env.DATA_DIR||__dirname;
const app=express(),server=http.createServer(app),io=new Server(server);
app.set('trust proxy', 1);
const db=new Database(path.join(dataDir,'maia.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,username TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('master','admin','operator')));
CREATE TABLE IF NOT EXISTS panels(id TEXT PRIMARY KEY,description TEXT NOT NULL,event_date TEXT,start_time TEXT,duration_minutes INTEGER NOT NULL DEFAULT 240,tolerance_minutes INTEGER NOT NULL DEFAULT 15,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS queue(id INTEGER PRIMARY KEY AUTOINCREMENT,panel_id TEXT NOT NULL REFERENCES panels(id) ON DELETE CASCADE,name TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'waiting',created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS queue_order ON queue(panel_id,status,id);
CREATE TABLE IF NOT EXISTS panel_sessions(panel_id TEXT PRIMARY KEY REFERENCES panels(id) ON DELETE CASCADE,status TEXT NOT NULL DEFAULT 'stopped',end_at INTEGER,remaining_seconds INTEGER NOT NULL DEFAULT 14400,updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS songs(panel_id TEXT PRIMARY KEY REFERENCES panels(id) ON DELETE CASCADE,title TEXT,video_id TEXT,singer TEXT,updated_at INTEGER);
`);
db.prepare("INSERT OR IGNORE INTO panels(id,description,duration_minutes,tolerance_minutes) VALUES('main','MAIA KARAOKÊ - Principal',240,15)").run();
const masterName=process.env.MASTER_USERNAME||'fabricio';
const masterPassword=process.env.MASTER_PASSWORD || '073240';
if(masterPassword==='073240') console.warn('ATENÇÃO: senha inicial padrão ativa. Troque MASTER_PASSWORD antes de publicar na internet.');
const exists=db.prepare('SELECT id FROM users WHERE username=?').get(masterName);
if(!exists) db.prepare('INSERT INTO users(username,password_hash,role) VALUES(?,?,?)').run(masterName,bcrypt.hashSync(masterPassword,12),'master');
const SQLiteStore=SQLiteStoreFactory(session);
app.use(helmet({contentSecurityPolicy:false}));
app.use(express.json({limit:'100kb'}));
app.use(session({store:new SQLiteStore({db:'sessions.sqlite',dir:dataDir}),secret:process.env.SESSION_SECRET||crypto.randomBytes(32).toString('hex'),resave:false,saveUninitialized:false,cookie:{httpOnly:true,sameSite:'lax',secure:process.env.NODE_ENV==='production',maxAge:8*60*60*1000}}));
app.use(express.static(path.join(__dirname,'public')));
const base=()=>process.env.BASE_URL||process.env.RENDER_EXTERNAL_URL||'http://localhost:'+(process.env.PORT||3000);
const auth=(req,res,next)=>req.session.user?next():res.status(401).json({error:'Faça login.'});
const master=(req,res,next)=>req.session.user?.role==='master'?next():res.status(403).json({error:'Somente o usuário master pode executar esta ação.'});
const operator=(req,res,next)=>['master','admin','operator'].includes(req.session.user?.role)?next():res.status(403).json({error:'Acesso não autorizado.'});
const getPanel=id=>db.prepare('SELECT * FROM panels WHERE id=?').get(id);
function queueState(id){
 const current=db.prepare("SELECT id,name FROM queue WHERE panel_id=? AND status='singing' ORDER BY id LIMIT 1").get(id)||null;
 const waiting=db.prepare("SELECT id,name,created_at FROM queue WHERE panel_id=? AND status='waiting' ORDER BY id").all(id);
 return {current,waiting};
}
function emitQueue(id){io.to('panel:'+id).emit('queue:update',queueState(id))}
function validPanel(req,res,next){const p=getPanel(req.params.panelId);if(!p)return res.status(404).json({error:'Painel não encontrado.'});req.panel=p;next()}
function sessionState(id){
 let s=db.prepare('SELECT * FROM panel_sessions WHERE panel_id=?').get(id);
 if(!s){s={panel_id:id,status:'stopped',end_at:null,remaining_seconds:(getPanel(id)?.duration_minutes||240)*60,updated_at:Date.now()};db.prepare('INSERT OR IGNORE INTO panel_sessions(panel_id,status,end_at,remaining_seconds,updated_at) VALUES(?,?,?,?,?)').run(s.panel_id,s.status,s.end_at,s.remaining_seconds,s.updated_at)}
 if(s.status==='running'){
  const remaining=Math.max(0,Math.ceil((s.end_at-Date.now())/1000));
  if(remaining===0){db.prepare("UPDATE panel_sessions SET status='finished',end_at=NULL,remaining_seconds=0,updated_at=? WHERE panel_id=?").run(Date.now(),id);s={...s,status:'finished',end_at:null,remaining_seconds:0}}
  else s={...s,remaining_seconds:remaining};
 }
 return {status:s.status,endAt:s.end_at,remainingSeconds:s.remaining_seconds};
}
app.get('/api/health',(req,res)=>res.json({ok:true,app:'MAIA KARAOKÊ',version:'2.0.0'}));
app.get('/api/config',(req,res)=>res.json({pixKey:process.env.PIX_KEY||'27996447565',whatsapp:process.env.WHATSAPP_NUMBER||'5527996447565'}));
app.post('/api/login',(req,res)=>{
 const {username,password}=req.body||{};
 const u=db.prepare('SELECT id,username,password_hash,role FROM users WHERE username=?').get(String(username||''));
 if(!u||!bcrypt.compareSync(String(password||''),u.password_hash))return res.status(401).json({error:'Usuário ou senha inválidos.'});
 req.session.user={id:u.id,username:u.username,role:u.role};res.json({user:req.session.user});
});
app.post('/api/logout',(req,res)=>req.session.destroy(()=>res.json({ok:true})));
app.get('/api/me',(req,res)=>res.json({user:req.session.user||null}));
app.get('/api/panels',auth,(req,res)=>res.json(db.prepare('SELECT * FROM panels ORDER BY created_at DESC').all()));
app.post('/api/panels',auth,master,(req,res)=>{
 const {description,eventDate,startTime,durationMinutes,toleranceMinutes}=req.body||{};
 const d=String(description||'').trim(),mins=Number(durationMinutes),tol=Number(toleranceMinutes);
 if(!d||!eventDate||!startTime||!Number.isInteger(mins)||mins<1||mins>10080||!Number.isInteger(tol)||tol<0||tol>1440)return res.status(400).json({error:'Confira local, data, hora, duração e tolerância.'});
 const id=crypto.randomBytes(9).toString('hex');
 db.prepare('INSERT INTO panels(id,description,event_date,start_time,duration_minutes,tolerance_minutes) VALUES(?,?,?,?,?,?)').run(id,d,eventDate,startTime,mins,tol);
 db.prepare('INSERT INTO panel_sessions(panel_id,status,remaining_seconds,updated_at) VALUES(?,?,?,?)').run(id,'stopped',mins*60,Date.now());
 res.json({id,description:d,adminLink:base()+'/painel/'+id,queueLink:base()+'/fila/'+id});
});
app.get('/api/panels/:panelId',validPanel,(req,res)=>res.json(req.panel));
app.get('/api/queue/:panelId',validPanel,(req,res)=>res.json(queueState(req.params.panelId)));
app.post('/api/queue/:panelId',validPanel,(req,res)=>{
 const id=req.params.panelId,name=String(req.body?.name||'').trim().slice(0,80);
 if(!name)return res.status(400).json({error:'Digite seu nome.'});
 const dup=db.prepare("SELECT id FROM queue WHERE panel_id=? AND lower(name)=lower(?) AND status IN ('waiting','singing')").get(id,name);
 if(dup)return res.status(409).json({error:'Esse nome já está na fila.'});
 db.prepare("INSERT INTO queue(panel_id,name,status) VALUES(?,?,'waiting')").run(id,name);emitQueue(id);res.json({ok:true});
});
app.post('/api/queue/:panelId/next',auth,validPanel,(req,res)=>{
 const id=req.params.panelId;
 db.prepare("UPDATE queue SET status='done' WHERE panel_id=? AND status='singing'").run(id);
 const n=db.prepare("SELECT id FROM queue WHERE panel_id=? AND status='waiting' ORDER BY id LIMIT 1").get(id);
 if(n)db.prepare("UPDATE queue SET status='singing' WHERE id=?").run(n.id);
 emitQueue(id);res.json(queueState(id));
});
app.post('/api/queue/:panelId/start',auth,validPanel,(req,res)=>{
 const id=req.params.panelId,cur=db.prepare("SELECT id FROM queue WHERE panel_id=? AND status='singing'").get(id);
 if(!cur){const n=db.prepare("SELECT id FROM queue WHERE panel_id=? AND status='waiting' ORDER BY id LIMIT 1").get(id);if(n)db.prepare("UPDATE queue SET status='singing' WHERE id=?").run(n.id)}
 emitQueue(id);res.json(queueState(id));
});
app.delete('/api/queue/:panelId/:entryId',auth,validPanel,(req,res)=>{
 db.prepare('DELETE FROM queue WHERE id=? AND panel_id=?').run(Number(req.params.entryId),req.params.panelId);emitQueue(req.params.panelId);res.json({ok:true});
});
app.get('/api/panels/:panelId/session',validPanel,(req,res)=>res.json(sessionState(req.params.panelId)));
app.post('/api/panels/:panelId/session',auth,validPanel,(req,res)=>{
 const id=req.params.panelId,{action,durationMinutes}=req.body||{};let s=sessionState(id),now=Date.now();
 if(action==='start'){
  let seconds=Number.isInteger(+durationMinutes)&&+durationMinutes>0?+durationMinutes*60:(s.remainingSeconds||req.panel.duration_minutes*60);
  db.prepare("INSERT INTO panel_sessions(panel_id,status,end_at,remaining_seconds,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(panel_id) DO UPDATE SET status='running',end_at=excluded.end_at,remaining_seconds=excluded.remaining_seconds,updated_at=excluded.updated_at").run(id,'running',now+seconds*1000,seconds,now);
 }else if(action==='pause'&&s.status==='running'){
  let left=Math.max(0,Math.ceil((s.endAt-now)/1000));
  db.prepare("UPDATE panel_sessions SET status='paused',end_at=NULL,remaining_seconds=?,updated_at=? WHERE panel_id=?").run(left,now,id);
 }else if(action==='resume'&&s.status==='paused'){
  db.prepare("UPDATE panel_sessions SET status='running',end_at=?,updated_at=? WHERE panel_id=?").run(now+s.remainingSeconds*1000,now,id);
 }else if(action==='reset'){
  const seconds=req.panel.duration_minutes*60;
  db.prepare("UPDATE panel_sessions SET status='stopped',end_at=NULL,remaining_seconds=?,updated_at=? WHERE panel_id=?").run(seconds,now,id);
 }else return res.status(400).json({error:'Ação de cronômetro inválida.'});
 const state=sessionState(id);io.to('panel:'+id).emit('session:update',state);res.json(state);
});
app.get('/api/panels/:panelId/song',validPanel,(req,res)=>res.json(db.prepare('SELECT title,video_id AS videoId,singer FROM songs WHERE panel_id=?').get(req.params.panelId)||{}));
app.post('/api/panels/:panelId/song',auth,validPanel,(req,res)=>{
 const id=req.params.panelId,{title,videoId,singer}=req.body||{};
 if(!title||!videoId||!/^[\w-]{11}$/.test(videoId))return res.status(400).json({error:'Informe música e vídeo válidos.'});
 db.prepare('INSERT INTO songs(panel_id,title,video_id,singer,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(panel_id) DO UPDATE SET title=excluded.title,video_id=excluded.video_id,singer=excluded.singer,updated_at=excluded.updated_at').run(id,String(title).slice(0,160),videoId,String(singer||'').slice(0,80),Date.now());
 const song={title,videoId,singer};io.to('panel:'+id).emit('song:update',song);res.json(song);
});
app.get('/api/users',auth,master,(req,res)=>res.json(db.prepare('SELECT id,username,role FROM users ORDER BY username').all()));
app.post('/api/users',auth,master,(req,res)=>{
 const {username,password,role}=req.body||{};
 if(!/^[a-zA-Z0-9_.-]{3,40}$/.test(username||'')||String(password||'').length<8||!['admin','operator'].includes(role))return res.status(400).json({error:'Login: 3 a 40 caracteres. Senha: mínimo 8 caracteres.'});
 try{db.prepare('INSERT INTO users(username,password_hash,role) VALUES(?,?,?)').run(username,bcrypt.hashSync(password,12),role);res.json({ok:true})}catch{return res.status(409).json({error:'Usuário já cadastrado.'})}
});
app.get('/api/qr/:panelId',validPanel,async(req,res)=>{try{const url=base()+'/fila/'+req.params.panelId;res.type('png').send(await QRCode.toBuffer(url,{width:420,margin:2}))}catch{res.status(500).json({error:'Não foi possível gerar QR Code.'})}});
app.get('/fila/:panelId',(req,res)=>res.sendFile(path.join(__dirname,'public','fila.html')));
app.get('/painel/:panelId',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.get('/musica/:panelId',(req,res)=>res.sendFile(path.join(__dirname,'public','tv.html')));
io.on('connection',s=>{s.on('join-panel',id=>{id=String(id||'').slice(0,100);if(getPanel(id)){s.join('panel:'+id);s.emit('queue:update',queueState(id));s.emit('session:update',sessionState(id));s.emit('song:update',db.prepare('SELECT title,video_id AS videoId,singer FROM songs WHERE panel_id=?').get(id)||{});}})});
const port=Number(process.env.PORT)||3000;
server.listen(port,'0.0.0.0',()=>console.log(`MAIA KARAOKÊ iniciado na porta ${port}`));
