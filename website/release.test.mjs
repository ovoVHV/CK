import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {webcrypto} from 'node:crypto';
import {verifyRelease} from './release.js';
const envelope=JSON.parse(fs.readFileSync(new URL('./fixtures/release-envelope.json',import.meta.url),'utf8'));
test('current signed release resolves to its own immutable installer',async()=>{
 const release=await verifyRelease(envelope,webcrypto);
 assert(release.url.endsWith(`CK-V${release.version}-Setup-x64.exe`));
});
test('changed release content is rejected before download URL is used',async()=>{
 const payload=JSON.parse(envelope.payload);payload.url='https://example.com/untrusted.exe';
 await assert.rejects(()=>verifyRelease({...envelope,payload:JSON.stringify(payload)},webcrypto),/signature mismatch/);
});
test('malformed signatures and oversized envelopes are rejected',async()=>{
 await assert.rejects(()=>verifyRelease({...envelope,signature:'00'},webcrypto),/Invalid/);
 await assert.rejects(()=>verifyRelease({...envelope,payload:'x'.repeat(65537)},webcrypto),/Invalid/);
});
const html=fs.readFileSync(new URL('./dist/download/index.html',import.meta.url),'utf8');
test('download page keeps a checked fallback and a visible release status',()=>{
 assert(html.includes('data-download-file'));assert(html.includes('data-release-status'));assert(html.includes('data-release-sha'));
});

test('static home and download fallback match the pinned signed release',async()=>{
 const pinned=await verifyRelease(JSON.parse(fs.readFileSync(new URL('./published-release.json',import.meta.url),'utf8')),webcrypto);
 const home=fs.readFileSync(new URL('./dist/index.html',import.meta.url),'utf8');
 for(const page of [home,html]) {
  assert(page.includes(`data-release-version>${pinned.version}</span>`));
  for(const match of page.matchAll(/data-release-version>([^<]+)<\/span>/g))assert.equal(match[1],pinned.version);
 }
 assert(html.includes(`href="${pinned.url}"`));
 for(const match of html.matchAll(/data-download-file[^>]*href="([^"]+)"/g))assert.equal(match[1],pinned.url);
 assert(html.includes(`data-release-sha>${pinned.sha256}</span>`));
 assert(html.includes(`data-release-size>${(pinned.size/1024/1024).toFixed(1)}</span>`));
});
