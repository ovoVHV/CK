// Exercise new reads with real project/compiler/Worker, then interruption/restart.
process.env.CK_AI_PHASE4_READS='1';
await import('./desktop-ai-phase3.mjs');
