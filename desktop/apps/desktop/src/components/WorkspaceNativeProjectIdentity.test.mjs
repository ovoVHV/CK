import fs from 'node:fs';import test from 'node:test';import assert from 'node:assert/strict';
const source=fs.readFileSync(new URL('Workspace.tsx',import.meta.url),'utf8');
test('compile and upload freeze project ownership separately from changing source fingerprints',()=>{
 const at=source.indexOf('const nativeBuildProjectId ='),freeze=source.indexOf('const buildEvidence: ForegroundBuildEvidence',at);
 assert(at>0&&freeze>at);const expression=source.slice(at,source.indexOf(';',at));
 for(const key of ['nativeBuildProjectRef.current','currentPathRef.current','reloadTriggerRef.current'])assert(expression.includes(key));
 assert(!expression.includes('codeFingerprint'));assert(!expression.includes('workspaceFingerprint'));
 for(const name of ['compile_sketch','upload_sketch']){const start=source.indexOf(`invoke('${name}'`),end=source.indexOf('}) as string',start),call=source.slice(start,end);assert(call.includes('projectId: nativeBuildProjectId'));assert(call.includes('workspaceFingerprint: buildEvidence.workspaceFingerprint'));}
});
