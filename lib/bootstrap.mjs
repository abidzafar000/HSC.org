import { hashPassword } from './access.mjs';
import { upgradeState } from './unit-upgrade.mjs';

const topology = [
  {id:'WH',name:'Central Warehouse',type:'warehouse'},
  {id:'B1',name:'Hamsun FSL',type:'branch',address:'',contact:'',phone:''},
  {id:'B2',name:'DHA',type:'branch'},
  {id:'B3',name:'Hamsun Clifon',type:'branch',address:'',contact:'',phone:''},
  {id:'B4',name:'Hamsun Extension',type:'branch',address:'',contact:'',phone:''},
];

/** The production workspace starts empty; existing location settings survive cleanup. */
export function emptyState(locations=[]) {
  const supplied=Array.isArray(locations)?locations:[];
  return {
    version:2,accessSchemaVersion:1,cleanStartVersion:1,
    sequence:{grn:0,transfer:0,return:0,adjustment:0,demand:0},
    locations:topology.map(defaults=>{
      const existing=supplied.find(location=>location?.id===defaults.id);
      return {...defaults,...(existing?structuredClone(existing):{}),id:defaults.id,type:defaults.type};
    }),
    products:[],suppliers:[],stock:[],documents:[],demands:[],ledger:[],audit:[],losses:[],
  };
}

/** Existing databases upgrade in place; a fresh database receives only its owner. */
export async function initializeWorkspace(db,{initialAdminPassword=process.env.HSC_INITIAL_ADMIN_PASSWORD}={}) {
  let record=await db.prepare("SELECT * FROM application WHERE id='main'").first();
  if(record) {
    for(let attempt=0;attempt<3;attempt++) {
      const state=JSON.parse(record.data);
      if(!upgradeState(state))return;
      const update=await db.prepare("UPDATE application SET data=?,revision=revision+1 WHERE id='main' AND revision=?").bind(JSON.stringify(state),record.revision).run();
      if(update.meta.changes===1)return;
      record=await db.prepare("SELECT * FROM application WHERE id='main'").first();
    }
    throw new Error('Records changed during the item-unit update. Refresh and try again.');
  }
  if(typeof initialAdminPassword!=='string'||initialAdminPassword.length<10||initialAdminPassword.length>256) {
    const error=new Error('Set HSC_INITIAL_ADMIN_PASSWORD to 10–256 characters before initializing an empty workspace.');
    error.status=503;
    throw error;
  }
  const password=await hashPassword(initialAdminPassword);
  await db.batch([
    db.prepare('INSERT OR IGNORE INTO users (id,email,name,role,branch_id,password) VALUES (?,?,?,?,?,?)').bind('admin','admin@hamsun.local','Abid Zafar','superadmin',null,password),
    db.prepare('INSERT OR IGNORE INTO application (id,data,revision) VALUES (?,?,0)').bind('main',JSON.stringify(emptyState())),
  ]);
}
