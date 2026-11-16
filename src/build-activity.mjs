// Presentation-only events. They never authorize a receipt or alter task identity.
export function compilerSourceArgument(argv) {
 const valueFlags = new Set(['-include','-imacros','-include-pch','-o','-MF','-MT','-MQ','-I','-isystem','-iquote','-idirafter']);
 const sources = argv.filter((arg,index) => index > 0 && !arg.startsWith('-') && !arg.startsWith('@')
  && !valueFlags.has(argv[index-1]) && /\.(cpp|c|cc|cxx|S|s|h|hpp)$/.test(arg));
 return sources.at(-1) ?? 'source';
}

export function reportActivity(c, message) {
 try { c.onActivity?.(String(message).replace(/[\r\n]+/g, ' ').slice(0, 512)); } catch {}
}

export function createActivityReporter(send, {now = () => performance.now(), intervalMs = 250} = {}) {
 let pending = [], timer, closed = false, last = -Infinity;
 function flush() {
  clearTimeout(timer); timer = undefined;
  if (!pending.length || closed) return;
  const messages = pending; pending = []; last = now();
  send(messages);
 }
 return {
  push(message) {
   if (closed) return;
   pending.push(String(message).replace(/[\r\n]+/g, ' ').slice(0, 512));
   // Keep a bounded burst without sending one IPC per compiler process.
   if (pending.length > 64) pending.splice(0, pending.length - 64);
   if (now() - last >= intervalMs) flush();
   else timer ??= setTimeout(flush, intervalMs - (now() - last));
  },
  close() { flush(); closed = true; clearTimeout(timer); },
 };
}
