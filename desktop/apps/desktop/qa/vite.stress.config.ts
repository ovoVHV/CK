import { defineConfig } from 'vite';
export default defineConfig({
    build:{outDir:'../../artifacts/benchmarks/blockly-50k-20261014/web',emptyOutDir:true,rollupOptions:{input:'qa/large-workspace.html'}},
});
