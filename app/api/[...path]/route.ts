import {handleApi} from '../../../lib/api.mjs';
import {getDatabase} from '../../../lib/postgres.mjs';

export const dynamic='force-dynamic';
export const runtime='nodejs';

function database(){try{return getDatabase();}catch{return null;}}
export function GET(request:Request){return handleApi(request,database());}
export function POST(request:Request){return handleApi(request,database());}
