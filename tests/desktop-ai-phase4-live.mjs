// Same workload, model, budgets and independent checks for both release EXEs.
process.env.CK_AI_LIVE_EVIDENCE_PREFIX='ai-phase4-'+(process.env.CK_AI_BENCH_LABEL||'candidate');
await import('./desktop-ai-phase3-live.mjs');
