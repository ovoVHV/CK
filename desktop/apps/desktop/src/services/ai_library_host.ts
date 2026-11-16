import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import { compileAiSource } from './ai_candidate';
import { sha256Hex } from './compile_source_map';
import { buildAiLibrary, type AiLibraryHost, type AiLibraryPreview } from './ai_library_authoring';
import type { ProjectBuildTarget } from './project_build_target';
import { forkAiLibrary } from './ai_library_revision';

export function createAiLibraryHost(input: {
    target: () => ProjectBuildTarget;
    reload: (preview: AiLibraryPreview, verify: boolean) => Promise<void>;
}): AiLibraryHost {
    return {
        readSource: (packageId,contentSha256,path,offset) => { const target=input.target();return invoke('ai_read_library_source',{packageId,contentSha256,path,offset,fqbn:target.fqbn,boardPackageId:target.boardPackageId}); },
        async revise(packageId,contentSha256) { const target=input.target(); const bundle=await invoke<{packageId:string;contentSha256:string;files:Record<string,string>}>('ai_read_library_source',{packageId,contentSha256,bundle:true,fqbn:target.fqbn,boardPackageId:target.boardPackageId}); if(bundle.packageId!==packageId||bundle.contentSha256!==contentSha256)throw Error('库修订来源身份不一致');return forkAiLibrary(bundle); },
        async validate(draft, context) {
            context.signal.throwIfAborted();
            const target = input.target();
            const { files, source, types } = buildAiLibrary(draft, target);
            context.onStep('正在校验库结构、能力声明和生成规则');
            const prepared = await invoke<{token:string;packageId:string;contentSha256:string}>('ai_prepare_library', {
                files, fqbn: target.fqbn, boardPackageId: target.boardPackageId, coreVersion: target.coreVersion, sourceSha256: sha256Hex(source),
            });
            try {
                context.signal.throwIfAborted();
                context.onStep(`正在隔离试编译 ${types.length} 个新积木`);
                const validation = await compileAiSource({ code: source, target, candidateId: crypto.randomUUID(), libraryToken: prepared.token, ...context });
                return { ...prepared, name: draft.name, version: draft.version, types, files: Object.keys(files), source, validation };
            } catch(error) { await invoke('ai_discard_library',{token:prepared.token}).catch(()=>undefined); throw error; }
        },
        async install(preview, signal, onStep, checkCurrent) {
            signal.throwIfAborted();
            checkCurrent?.();
            let installed = false;
            try {
                onStep('正在安装已验证的库');
                await invoke('ai_install_library', { token: preview.token }); installed = true;
                signal.throwIfAborted();
                checkCurrent?.();
                onStep('正在加载新积木并检查可用状态');
                await input.reload(preview, true);
                signal.throwIfAborted();
                checkCurrent?.();
                await invoke('ai_finish_library', { token: preview.token, loaded: true });
            } catch (error) {
                if (installed) {
                    await invoke('ai_finish_library', { token: preview.token, loaded: false });
                    await input.reload(preview, false);
                }
                throw error;
            }
        },
        discard: token => invoke('ai_discard_library', { token }),
        async export(preview) {
            const destination = await save({ defaultPath: `${preview.packageId}-${preview.version}.zip`, filters: [{ name: 'CK 积木库', extensions: ['zip'] }] });
            if (!destination) return null;
            await invoke('ai_export_library', { token: preview.token, destination }); return destination;
        },
    };
}
