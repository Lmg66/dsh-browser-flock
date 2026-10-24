import { WindowsPlatform } from '../src/host/platform/windows.js';
import { defaultCandidates } from '../src/host/browser-adapters.js';
const platform=new WindowsPlatform();
for(const candidate of defaultCandidates('win32',process.env)) {
  try {const runtime=await platform.inspectExecutable(candidate);console.log(JSON.stringify(runtime));}
  catch(error) {if(error.code!=='ENOENT') console.error(JSON.stringify({path:candidate.path,code:error.code,message:error.message}));}
}
