import {emptyState} from './bootstrap.mjs';
import {problem,publicUser} from './access.mjs';

const requireValue=(condition,message,status=400)=>{if(!condition)throw problem(message,status);};
const ownerSessionSql="SELECT users.* FROM users JOIN sessions ON sessions.user_id=users.id WHERE users.id='admin' AND users.role='superadmin' AND users.active=1 AND sessions.token=? AND sessions.expires>?";
const commitGuard="EXISTS (SELECT 1 FROM application WHERE id='main' AND revision=? AND json_extract(data,'$.lastAccessMutation')=?)";

/** One-time clean start against the owner's explicitly reviewed revision. */
export async function clearSampleData(db,actor,payload,expectedRevision,sessionHash){
  requireValue(actor?.id==='admin','Only the original Super Admin can clear sample data.',403);
  const record=await db.prepare("SELECT * FROM application WHERE id='main'").first();
  requireValue(record,'The workspace is unavailable.',503);
  const current=await db.prepare(ownerSessionSql).bind(sessionHash,Date.now()).first();
  requireValue(current,'An active original Super Admin session is required.',403);
  actor=publicUser(current);
  requireValue(payload&&typeof payload==='object'&&!Array.isArray(payload),'Send cleanup details as an object.');
  requireValue(payload.confirmation==='DELETE SAMPLE DATA','Confirm the sample data cleanup explicitly.');
  requireValue(payload.keepUserId===actor.id,'The original Super Admin account must be retained.');
  requireValue(Number.isSafeInteger(expectedRevision)&&expectedRevision>=0,'A current workspace revision is required.');
  requireValue(record.revision===expectedRevision,'Records changed after review. Review the current workspace and try again.',409);
  const previous=JSON.parse(record.data);
  requireValue(!(previous.cleanStartVersion>=1),'Sample data has already been cleared.',409);

  const deleted=Object.fromEntries(['products','suppliers','stock','documents','ledger','audit','losses'].map(key=>[key,Array.isArray(previous[key])?previous[key].length:0]));
  deleted.users=(await db.prepare('SELECT COUNT(*) AS count FROM users WHERE id<>?').bind(actor.id).first()).count;
  deleted.sessions=(await db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE user_id<>?').bind(actor.id).first()).count;
  deleted.loginLimits=(await db.prepare('SELECT COUNT(*) AS count FROM login_limits').first()).count;

  const state=emptyState(previous.locations);
  const operation=crypto.randomUUID();
  const revision=record.revision+1;
  state.lastAccessMutation=operation;
  state.audit=[{id:`AUD_${crypto.randomUUID()}`,at:new Date().toISOString(),userId:actor.id,userName:actor.name,role:actor.role,action:'workspace.clear-sample-data',entityId:'main',reference:'CLEAN START',branchId:null,detail:`Sample data removed: ${JSON.stringify(deleted)}. Original Super Admin retained.`}];
  const results=await db.batch([
    db.prepare(`UPDATE application SET data=?,revision=revision+1 WHERE id='main' AND revision=? AND EXISTS (${ownerSessionSql})`).bind(JSON.stringify(state),record.revision,sessionHash,Date.now()),
    db.prepare(`DELETE FROM sessions WHERE user_id<>? AND ${commitGuard}`).bind(actor.id,revision,operation),
    db.prepare(`DELETE FROM users WHERE id<>? AND ${commitGuard}`).bind(actor.id,revision,operation),
    db.prepare(`DELETE FROM login_limits WHERE ${commitGuard}`).bind(revision,operation),
  ]);
  if(results[0].meta.changes!==1){
    const active=await db.prepare(ownerSessionSql).bind(sessionHash,Date.now()).first();
    requireValue(active,'Your Super Admin session changed. Sign in again.',403);
    throw problem('Records changed after review. Review the current workspace and try again.',409);
  }
  return {state,revision,result:{deleted,keptUserId:actor.id}};
}
