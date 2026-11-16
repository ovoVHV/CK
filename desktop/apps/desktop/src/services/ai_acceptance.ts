import { sha256Hex } from './compile_source_map';

export interface AiRequirement { id: string; text: string; method: 'simulation' | 'review' | 'hardware' }
export interface AiStimulus { atMs: number; pin: string; value: number }
export type AiAssertion = { id: string; requirement: string } & (
    | { kind: 'pin'; atMs: number; pin: string; value: 0 | 1 }
    | { kind: 'edges'; fromMs: number; toMs: number; pin: string; min: number; max: number }
    | { kind: 'serial'; fromMs: number; toMs: number; contains: string }
);
export interface AiScenario { id: string; name: string; durationMs: number; inputs: AiStimulus[]; assertions: AiAssertion[] }
export interface AiAcceptance { version: 1; requirements: AiRequirement[]; scenarios: AiScenario[] }
export interface AiFirmware { format: 'ihex'; content: string; sha256: string; fqbn: string; sourceSha256: string }
export interface AiBehaviorCheck { scenario: string; id: string; requirement: string; ok: boolean; expected: string; actual: string }
export interface AiBehaviorResult {
    status: 'passed' | 'failed' | 'unsupported'; contractSha256: string; sourceSha256: string;
    firmwareSha256?: string; fqbn: string; elapsedMs: number; checks: AiBehaviorCheck[]; reason?: string;
    engine: 'avr8js-0.21.1'; hardware: false;
}
export const AI_BEHAVIOR_LIMITS = { scenarios: 6, perScenarioMs: 5000, totalMs: 12000, wallMs: 60000, assertions: 128, inputs: 256 } as const;
const plain = (v: any): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const require: (ok: unknown, message: string) => asserts ok = (ok, message) => { if (!ok) throw Error(message); };
function shape(v: unknown, keys: string[], label: string): asserts v is Record<string, any> {
    require(plain(v) && Object.keys(v).every(k => keys.includes(k)), `${label}含未知字段或不是对象`);
}
const text = (v: unknown, max: number) => typeof v === 'string' && !!v.trim() && v.length <= max && !v.includes('\0');
const id = (v: unknown) => typeof v === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(v);
const integer = (v: unknown, min: number, max: number) => Number.isSafeInteger(v) && Number(v) >= min && Number(v) <= max;
export function aiSimulationTarget(target: unknown): string | null {
    const fqbn = typeof target === 'string' ? target : plain(target) ? target.fqbn : undefined;
    if (typeof fqbn !== 'string') return null;
    const [pkg, arch, board, options = '', ...rest] = fqbn.split(':');
    // A carrier package may share the compiler target but use different wiring.
    if (plain(target) && target.boardPackageId && target.boardPackageId !== [pkg, arch, board].join(':')) return null;
    if (rest.length || pkg !== 'arduino' || arch !== 'avr' || !['uno', 'nano'].includes(board)) return null;
    const pairs = options ? options.split(',') : [];
    if (pairs.some(p => !/^cpu=atmega328(?:old)?$/.test(p)) || pairs.length > 1 || (board === 'uno' && pairs.length)) return null;
    return 'atmega328p-16mhz';
}
export function parseAiAcceptance(value: unknown): AiAcceptance {
    shape(value, ['version', 'requirements', 'scenarios'], '验收计划');
    require(value.version === 1, '验收计划version必须为1');
    require(Array.isArray(value.requirements) && value.requirements.length > 0 && value.requirements.length <= 24, '验收条件需要1–24项');
    const ids = new Set<string>();
    const requirements = value.requirements.map((r: any) => {
        shape(r, ['id', 'text', 'method'], '验收条件');
        require(id(r.id) && !ids.has(r.id) && text(r.text, 500) && ['simulation', 'review', 'hardware'].includes(r.method), '验收条件编号、文字或验证方式无效');
        ids.add(r.id); return { id: r.id, text: r.text.trim(), method: r.method } as AiRequirement;
    });
    require(Array.isArray(value.scenarios) && value.scenarios.length <= AI_BEHAVIOR_LIMITS.scenarios, '测试场景最多6项');
    const scenarioIds = new Set<string>(), assertionIds = new Set<string>(), covered = new Set<string>();
    let duration = 0, inputs = 0;
    const scenarios = value.scenarios.map((s: any) => {
        shape(s, ['id', 'name', 'durationMs', 'inputs', 'assertions'], '测试场景');
        require(id(s.id) && !scenarioIds.has(s.id) && text(s.name, 160), '测试场景编号或名称无效');
        scenarioIds.add(s.id);
        require(integer(s.durationMs, 1, AI_BEHAVIOR_LIMITS.perScenarioMs), '单个场景需要1–5000毫秒'); duration += s.durationMs;
        require(Array.isArray(s.inputs) && (inputs += s.inputs.length) <= AI_BEHAVIOR_LIMITS.inputs, '测试输入超过256项');
        const driven = new Set<string>();
        const stimuli = s.inputs.map((i: any) => {
            shape(i, ['atMs', 'pin', 'value'], '测试输入');
            require(integer(i.atMs, 0, s.durationMs), '输入时间超出场景');
            require(typeof i.pin === 'string' && /^(D(?:[0-9]|1[0-3])|A[0-5])$/.test(i.pin), '输入引脚只支持D0–D13、A0–A5');
            require(integer(i.value, 0, i.pin.startsWith('A') ? 1023 : 1), '数字输入值为0/1；模拟输入为0–1023');
            const key = `${i.atMs}:${i.pin}`; require(!driven.has(key), '同一时间不能重复设置同一输入'); driven.add(key);
            return { atMs: i.atMs, pin: i.pin, value: i.value };
        }).sort((a: AiStimulus, b: AiStimulus) => a.atMs - b.atMs);
        require(Array.isArray(s.assertions) && s.assertions.length > 0, '每个场景必须有断言');
        const assertions = s.assertions.map((a: any) => {
            const keys = a?.kind === 'pin' ? ['atMs', 'pin', 'value'] : a?.kind === 'edges' ? ['fromMs', 'toMs', 'pin', 'min', 'max'] : ['fromMs', 'toMs', 'contains'];
            shape(a, ['id', 'requirement', 'kind', ...keys], '测试断言');
            require(id(a.id) && !assertionIds.has(a.id) && requirements.some((r: AiRequirement) => r.id === a.requirement && r.method === 'simulation'), '断言需要唯一编号并关联simulation验收条件');
            assertionIds.add(a.id); covered.add(a.requirement);
            if (a.kind === 'pin') {
                require(integer(a.atMs, 1, s.durationMs) && integer(a.value, 0, 1), '引脚断言时间或电平无效');
            } else {
                require(integer(a.fromMs, 0, s.durationMs - 1) && integer(a.toMs, a.fromMs + 1, s.durationMs), '断言时间窗口无效');
                if (a.kind === 'edges') require(integer(a.min, 0, 10000) && integer(a.max, a.min, 10000), '变化次数应为0–10000，max不得小于min；保持不变可用min=0,max=0');
                else require(a.kind === 'serial' && text(a.contains, 256), '串口断言需要非空contains文字');
            }
            if (a.kind !== 'serial') {
                require(typeof a.pin === 'string' && /^D(?:[0-9]|1[0-3])$/.test(a.pin), '输出断言只支持D0–D13');
                require(!stimuli.some((i: AiStimulus) => i.pin === a.pin), '不得对外部输入引脚断言输出成功');
            }
            return structuredClone(a) as AiAssertion;
        });
        return { id: s.id, name: s.name.trim(), durationMs: s.durationMs, inputs: stimuli, assertions } as AiScenario;
    });
    require(duration <= AI_BEHAVIOR_LIMITS.totalMs && assertionIds.size <= AI_BEHAVIOR_LIMITS.assertions, '测试总时长或断言超过预算');
    require(requirements.every((r: AiRequirement) => r.method !== 'simulation' || covered.has(r.id)), '每项模拟验收条件至少关联一个真实断言');
    // Every scenario resets the same firmware. Missing stimuli must not silently
    // inherit a value from another scenario or the simulator's default state.
    const externalPins = [...new Set(scenarios.flatMap((s: AiScenario) => s.inputs.map(i => i.pin)))];
    for (const scenario of scenarios) {
        const missing = externalPins.filter(pin => !scenario.inputs.some((i: AiStimulus) => i.pin === pin && i.atMs === 0));
        require(!missing.length, `验收尚未锁定：场景${scenario.id}缺少外部输入${missing.join('、')}在0ms的明确初值。同一固件每个场景都须初始化本计划声明的所有外部输入，不能猜默认电平；请补齐后重新提交完整计划。`);
    }
    return { version: 1, requirements, scenarios };
}
export const aiAcceptanceHash = (contract: AiAcceptance) => sha256Hex(JSON.stringify(parseAiAcceptance(contract)));
export function lockAiAcceptance(prior: AiAcceptance | undefined, value: unknown): AiAcceptance {
    const next = parseAiAcceptance(value);
    if (prior && aiAcceptanceHash(prior) !== aiAcceptanceHash(next)) throw Error('验收条件已固定，不能删改断言、降低标准或改成未验证来通过；请修复工程。需求确有变化时由用户另开任务。');
    return next;
}
export function aiRequirementStatus(contract: AiAcceptance, result?: AiBehaviorResult) {
    const current = result?.contractSha256 === aiAcceptanceHash(contract) ? result : undefined;
    return contract.requirements.map(r => {
        const rows = current?.checks.filter(c => c.requirement === r.id) || [];
        const expected = contract.scenarios.flatMap(s => s.assertions).filter(a => a.requirement === r.id).length;
        const status = r.method !== 'simulation' || !current || current.status === 'unsupported' ? 'unverified'
            : rows.some(c => !c.ok) ? 'failed' : rows.length === expected && expected > 0 ? 'passed' : 'unverified';
        return { ...r, status };
    });
}
