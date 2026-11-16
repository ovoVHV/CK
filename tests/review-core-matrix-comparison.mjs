// Review the initial harness's JSON key-order false positives without rerunning
// firmware or changing the original samples. Never ignores array/argv order.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
const file=path.resolve(process.argv[2]),bytes=fs.readFileSync(file),report=JSON.parse(bytes);
assert(report.finishedAt);assert.equal(report.runs.length,9);assert(report.runs.every(r=>r.success&&r.host?.worker?.success));
assert.equal(report.official.length,3);assert(report.official.every(r=>r.code===0&&r.artifactCount===10));
const reviewed=report.official.map(row=>({label:row.label,objects:row.objectCount,artifacts:row.artifactCount,
 keyOrderOnly:row.differences.filter(d=>isDeepStrictEqual(d.actual,d.expected)).map(d=>d.name),
 remainingDifferences:row.differences.filter(d=>!isDeepStrictEqual(d.actual,d.expected))}));
assert(reviewed.every(r=>r.remainingDifferences.length===0),'Actual output difference');
if(report.status!=='PASS')assert.match(report.error,/Official output differences/);
const result={status:'PASS',reviewedAt:new Date().toISOString(),sourceReport:file,sourceReportSha256:createHash('sha256').update(bytes).digest('hex'),
 method:'Structural deep equality; object key order ignored, array order, command argv, all values and artifact hashes preserved; original report unchanged',reviewed};
const out=path.join(path.dirname(file),'comparison-review.json');fs.writeFileSync(out,JSON.stringify(result,null,2));console.log(out);
