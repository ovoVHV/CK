import fs from 'node:fs';
import path from 'node:path';
export function beneath(root, candidate, allowRoot=false) {
  const relative=path.relative(path.resolve(root),path.resolve(candidate));
  return (allowRoot || relative!=='') && relative!=='..' && !relative.startsWith('..'+path.sep) && !path.isAbsolute(relative);
}
export function rejectReparse(file) {
  for(let p=path.resolve(file);;p=path.dirname(p)) {
    if(fs.lstatSync(p,{throwIfNoEntry:false})?.isSymbolicLink()) throw Error('Reparse path rejected: '+p);
    if(path.dirname(p)===p)break;
  }
}
export function checkedWorkspace(request, root) {
  if(!path.isAbsolute(request.workspace)||!beneath(root,request.workspace))throw Error('Workspace outside configured sessions root');
  if(path.resolve(request.sketchDir).toLowerCase()!==path.resolve(request.workspace,'source/sketch').toLowerCase())throw Error('Unexpected Sketch path');
  rejectReparse(request.workspace);rejectReparse(request.sketchDir);
  fs.mkdirSync(request.workspace,{recursive:true});
  return fs.realpathSync.native(request.workspace).toLowerCase();
}
export function checkedBuildPath(c, file, allowRoot=false) {
  checkedWorkspace(c,c.workspaceRoot);
  const build=path.resolve(c.workspace,'build');
  if(!beneath(build,file,allowRoot))throw Error('Write outside owned build directory');
  rejectReparse(file);
  return path.resolve(file);
}
