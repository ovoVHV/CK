import {StringDecoder} from 'node:string_decoder';

// Optional presentation stream; the final result retains the existing envelope.
export function createBuildStreamReader(requestId, onActivity) {
 const decoder = new StringDecoder('utf8');
 let pending = '', bytes = 0, result, ended = false;
 function consume(text) {
  pending += text;
  let end;
  while ((end = pending.indexOf('\n')) >= 0) {
   const line = pending.slice(0, end); pending = pending.slice(end + 1);
   if (!line.trim()) continue;
   const frame = JSON.parse(line);
   if (frame.requestId !== requestId || ended) throw Error('Unexpected build stream identity/order');
   if (frame.type === 'activity') {
    if (!Array.isArray(frame.messages) || frame.messages.length > 64 || frame.messages.some(x => typeof x !== 'string' || x.length > 512)) throw Error('Invalid build activity');
    onActivity(frame.messages);
   } else if (frame.type === 'result') { result = frame.receipt; ended = true; }
   else throw Error('Unknown build stream frame');
  }
 }
 return {
  push(chunk) { bytes += chunk.length; if (bytes > 32 * 1024 * 1024) throw Error('Oversized engine response'); consume(decoder.write(chunk)); },
  finish() { consume(decoder.end()); if (pending.trim() || !ended) throw Error('Incomplete build stream'); return result; },
 };
}
