import { execute, scopedState } from './engine.mjs';
import { initializeWorkspace } from './bootstrap.mjs';
import { clearSampleData } from './maintenance.mjs';
import { randomToken, digest, hashPassword, safeEqual, publicUser, listUsers, ensureOwnerAccess, saveAccount, changeOwnPassword, problem } from './access.mjs';
import {actionAllowed,filterModuleState,hasPermission} from './permissions.mjs';
import {canReceiveDemandAlerts,pendingDemandAlerts} from './demand-alerts.mjs';
const visibleState=(state,user)=>filterModuleState(scopedState(state,user),user);

async function authenticated(db,request) {
  const token=(request.headers.get('cookie')||'').match(/(?:^|;\s*)hamsun_session=([a-f0-9]{64})(?:;|$)/)?.[1];
  if(!token)return null;
  const row=await db.prepare('SELECT users.* FROM users JOIN sessions ON sessions.user_id=users.id WHERE sessions.token=? AND sessions.expires>? AND users.active=1').bind(await digest(token),Date.now()).first();
  return row?publicUser(row):null;
}
const json = (body,status=200,headers={})=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff',...headers}});
function cookie(token, request,clear=false) {return `hamsun_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear?0:28800}${new URL(request.url).protocol==='https:'?'; Secure':''}`;}

async function readObject(request) {
  const reader=request.body?.getReader();
  if(!reader)throw problem('Send a JSON object.');
  const decoder=new TextDecoder();
  let body='',length=0;
  try {
    while(true) {
      const {value,done}=await reader.read();
      if(done)break;
      length+=value.byteLength;
      if(length>100000) {
        await reader.cancel();
        throw problem('Request is too large.',413);
      }
      body+=decoder.decode(value,{stream:true});
    }
    body+=decoder.decode();
  } finally {reader.releaseLock();}
  const value=JSON.parse(body);
  if(!value||typeof value!=='object'||Array.isArray(value))throw problem('Send a JSON object.');
  return value;
}

export async function handleApi(request,db) {
  try {
    if(!db)return json({error:'Database is unavailable. Run the local database setup first.'},503);
    const path=new URL(request.url).pathname.replace(/\/$/,'');
    if(request.method!=='GET') {
      const origin=request.headers.get('origin');
      if(origin&&origin!==new URL(request.url).origin)return json({error:'Request origin is not allowed.'},403);
      if(!request.headers.get('content-type')?.includes('application/json'))return json({error:'Send application/json.'},415);
    }
    await initializeWorkspace(db);
    await ensureOwnerAccess(db);
    let user=await authenticated(db,request);
    if(path==='/api/session'&&request.method==='GET')return json({user});
    if(path==='/api/login'&&request.method==='POST') {
      const payload=await readObject(request);
      if(typeof payload.email!=='string'||typeof payload.password!=='string'||payload.password.length>256)return json({error:'Enter your email and password.'},400);
      const email=payload.email.trim().toLowerCase();
      // Caller-supplied proxy headers must not let repeated attempts evade the account lock.
      const key=await digest(`login:${email}`);
      const limit=await db.prepare('SELECT * FROM login_limits WHERE id=?').bind(key).first();
      if(limit&&limit.until>Date.now()&&limit.attempts>=8)return json({error:'Too many attempts. Try again in 15 minutes.'},429);
      const found=await db.prepare('SELECT * FROM users WHERE email=? AND active=1').bind(email).first();
      const salt=found?.password.split(':')[0]||'unavailable-user-salt';
      const candidate=await hashPassword(payload.password,salt);
      if(!found||!safeEqual(candidate,found.password)) {
        await db.prepare('INSERT INTO login_limits(id,attempts,until) VALUES(?,1,?) ON CONFLICT(id) DO UPDATE SET attempts=CASE WHEN until<? THEN 1 ELSE attempts+1 END,until=?').bind(key,Date.now()+900000,Date.now(),Date.now()+900000).run();
        return json({error:'Email or password is incorrect.'},401);
      }
      const token=randomToken();
      const loginWrite=await db.batch([
        db.prepare('DELETE FROM login_limits WHERE id=?').bind(key),
        db.prepare('DELETE FROM sessions WHERE expires<?').bind(Date.now()),
        db.prepare('INSERT INTO sessions(token,user_id,expires) SELECT ?,id,? FROM users WHERE id=? AND password=? AND active=1').bind(await digest(token),Date.now()+28800000,found.id,found.password),
      ]);
      if(loginWrite[2].meta.changes!==1)return json({error:'Account changed while signing in. Please try again.'},401);
      const current=await db.prepare('SELECT * FROM users WHERE id=? AND active=1').bind(found.id).first();
      if(!current)return json({error:'Account changed while signing in. Please try again.'},401);
      return json({user:publicUser(current)},200,{'set-cookie':cookie(token,request)});
    }
    if(path==='/api/logout'&&request.method==='POST') {
      const token=(request.headers.get('cookie')||'').match(/hamsun_session=([a-f0-9]{64})/)?.[1];
      if(token)await db.prepare('DELETE FROM sessions WHERE token=?').bind(await digest(token)).run();
      return json({ok:true},200,{'set-cookie':cookie('',request,true)});
    }
    if(!user)return json({error:'Sign in to continue.'},401);
    if(path==='/api/demand-alerts'&&request.method==='GET') {
      if(!canReceiveDemandAlerts(user))return json({error:'Your account does not have permission for demand alerts.'},403);
      const record=await db.prepare("SELECT * FROM application WHERE id='main'").first();
      user=await authenticated(db,request);
      if(!user)return json({error:'Your session changed. Sign in again.'},401);
      if(!canReceiveDemandAlerts(user))return json({error:'Your account does not have permission for demand alerts.'},403);
      const state=JSON.parse(record.data);
      const branches=new Map((state.locations||[]).filter(location=>location.type==='branch').map(location=>[location.id,location.name]));
      const alerts=pendingDemandAlerts(state.demands,user).map(alert=>({...alert,branchName:branches.get(alert.branchId)||'Branch'}));
      return json({alerts,revision:record.revision});
    }
    if(path==='/api/state'&&request.method==='GET') {
      const record=await db.prepare("SELECT * FROM application WHERE id='main'").first();
      user=await authenticated(db,request);
      if(!user)return json({error:'Your session changed. Sign in again.'},401);
      return json({state:visibleState(JSON.parse(record.data),user),user,revision:record.revision,users:user.role==='superadmin'?await listUsers(db):[]});
    }
    if(path==='/api/backup'&&request.method==='GET') {
      const record=await db.prepare("SELECT * FROM application WHERE id='main'").first();
      user=await authenticated(db,request);
      if(user?.role!=='superadmin')return json({error:'Only Super Admin can export a complete backup.'},403);
      return json({format:'hamsun-phase1-backup-v1',exportedAt:new Date().toISOString(),state:JSON.parse(record.data),users:await listUsers(db),revision:record.revision},200,{'content-disposition':'attachment; filename="hamsun-phase1-backup.json"'});
    }
    if(path==='/api/password'&&request.method==='POST') {
      if(!hasPermission(user,'security'))return json({error:'Your account does not have permission for Security.'},403);
      const payload=await readObject(request);
      const token=(request.headers.get('cookie')||'').match(/hamsun_session=([a-f0-9]{64})/)?.[1];
      const changed=await changeOwnPassword(db,user,payload,await digest(token));
      return json({ok:true,user,revision:changed.revision,state:visibleState(changed.state,user)});
    }
    if(path==='/api/action'&&request.method==='POST') {
      const {action,payload={},revision}=await readObject(request);
      if(typeof action!=='string'||!payload||typeof payload!=='object'||Array.isArray(payload))return json({error:'Invalid action.'},400);
      if(action==='workspace.clear-sample-data') {
        const token=(request.headers.get('cookie')||'').match(/hamsun_session=([a-f0-9]{64})/)?.[1];
        const cleared=await clearSampleData(db,user,payload,revision,await digest(token));
        const kept=publicUser(await db.prepare('SELECT * FROM users WHERE id=?').bind(user.id).first());
        return json({...cleared,user:kept,users:await listUsers(db)});
      }
      if(action==='user.save') {
        const token=(request.headers.get('cookie')||'').match(/hamsun_session=([a-f0-9]{64})/)?.[1];
        const saved=await saveAccount(db,user,payload,revision,await digest(token));
        const refreshed=publicUser(await db.prepare('SELECT * FROM users WHERE id=?').bind(user.id).first());
        return json({state:visibleState(saved.state,refreshed),user:refreshed,revision:saved.revision,result:saved.result,users:await listUsers(db)});
      }
      const record=await db.prepare("SELECT * FROM application WHERE id='main'").first();
      user=await authenticated(db,request);
      if(!user)return json({error:'Your session changed. Sign in again.'},401);
      if(revision!==undefined&&revision!==record.revision)return json({error:'Another user updated these records. Refresh and try again.'},409);
      const state=JSON.parse(record.data);
      if(!actionAllowed(user,action,payload,state))return json({error:'Your account does not have permission for this operation.'},403);
      const result=execute(state,user,action,payload);
      const update=await db.prepare("UPDATE application SET data=?,revision=revision+1 WHERE id='main' AND revision=?").bind(JSON.stringify(state),record.revision).run();
      if(update.meta.changes!==1)return json({error:'Another user updated these records. Refresh and try again.'},409);
      return json({state:visibleState(state,user),user,revision:record.revision+1,result:user.role==='branch'?undefined:result,users:user.role==='superadmin'?await listUsers(db):[]});
    }
    return json({error:'Page not found.'},404);
  }catch(error) {
    if(error instanceof SyntaxError)return json({error:'Invalid JSON request.'},400);
    const message=error?.message||'Unable to complete this action.';
    if(/SQLITE|D1_ERROR|no such table|database/i.test(message)){console.error('Database operation failed',message);return json({error:'Database setup required. Please apply the supplied migrations.'},503);}
    return json({error:message},error.status||400);
  }
}
