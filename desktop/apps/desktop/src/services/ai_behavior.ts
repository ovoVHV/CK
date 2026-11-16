import { AI_BEHAVIOR_LIMITS, aiAcceptanceHash, aiSimulationTarget, type AiAcceptance, type AiBehaviorResult, type AiFirmware } from './ai_acceptance';
import { sha256Hex } from './compile_source_map';
export type AiValidateBehavior = (input: { contract: AiAcceptance; firmware?: AiFirmware; sourceSha256: string; fqbn: string; signal: AbortSignal; onStep: (text: string) => void }) => Promise<AiBehaviorResult>;
export const validateAiBehavior: AiValidateBehavior = async input => {
    input.signal.throwIfAborted();
    const unavailable = (reason: string): AiBehaviorResult => ({ status: 'unsupported', reason,
        contractSha256: aiAcceptanceHash(input.contract), sourceSha256: input.sourceSha256, fqbn: input.fqbn, elapsedMs: 0, checks: [], engine: 'avr8js-0.21.1', hardware: false });
    if (!aiSimulationTarget(input.fqbn)) return unavailable('当前板卡尚无可用指令模拟；保留编译验证与待验证清单');
    if (!input.firmware) return unavailable('本次编译没有返回可绑定身份的HEX，未执行行为验证');
    if (input.firmware.sourceSha256 !== input.sourceSha256 || input.firmware.fqbn !== input.fqbn || sha256Hex(input.firmware.content) !== input.firmware.sha256) throw Error('行为验证固件与候选身份不符');
    return new Promise((resolve, reject) => {
        const worker = new Worker(new URL('./ai_behavior.worker.ts', import.meta.url), { type: 'module' });
        const finish = (error?: unknown, result?: AiBehaviorResult) => { clearTimeout(timer); input.signal.removeEventListener('abort', cancel); worker.terminate(); error ? reject(error) : resolve(result!); };
        const cancel = () => finish(input.signal.reason || new DOMException('已停止行为验证', 'AbortError'));
        const timer = setTimeout(() => finish(undefined, unavailable('行为验证超时，已停止模拟器')), AI_BEHAVIOR_LIMITS.wallMs + 5000);
        input.signal.addEventListener('abort', cancel, { once: true });
        worker.onerror = () => finish(Error('行为模拟器启动或执行失败，未产生通过证据'));
        worker.onmessage = event => {
            const message = event.data;
            if (message.progress) { input.onStep('正在验证行为：' + message.progress); return; }
            if (message.error) { finish(Error(message.error)); return; }
            const r = message.result as AiBehaviorResult;
            if (!r || r.sourceSha256 !== input.sourceSha256 || r.firmwareSha256 !== input.firmware!.sha256 || r.contractSha256 !== aiAcceptanceHash(input.contract) || r.fqbn !== input.fqbn || r.hardware !== false) { finish(Error('行为验证返回了不匹配的结果')); return; }
            finish(undefined, r);
        };
        worker.postMessage({ firmware: input.firmware, contract: input.contract });
        if (input.signal.aborted) cancel();
    });
};
