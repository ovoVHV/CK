// The firmware stays inside an emulated MCU. No generated source is evaluated
// as desktop JavaScript, and no host compiler/administrator service is needed.
import { CPU, avrInstruction, AVRIOPort, portBConfig, portCConfig, portDConfig, PinState,
    AVRTimer, timer0Config, timer1Config, timer2Config, AVRUSART, usart0Config,
    AVRADC, adcConfig, ADCMuxInputType, ADCReference } from 'avr8js';
import { sha256Hex } from './compile_source_map';
import { AI_BEHAVIOR_LIMITS, aiAcceptanceHash, aiSimulationTarget, parseAiAcceptance,
    type AiAcceptance, type AiFirmware, type AiBehaviorResult, type AiBehaviorCheck } from './ai_acceptance';

export function parseAiHex(hex: string): Uint16Array {
    if (hex.length > 200000) throw Error('HEX超过ATmega328P容量');
    const bytes = new Uint8Array(32768).fill(255), written = new Set<number>();
    let base = 0, end = false;
    for (const line of hex.trim().split(/\r?\n/)) {
        if (end || !/^:[0-9A-Fa-f]+$/.test(line) || line.length % 2 !== 1) throw Error('HEX记录格式无效');
        const data = Uint8Array.from(line.slice(1).match(/../g)!, v => parseInt(v, 16));
        if (data.length !== data[0] + 5 || (data.reduce((a, b) => a + b, 0) & 255)) throw Error('HEX记录长度或校验和无效');
        const addr = data[1] * 256 + data[2], type = data[3], count = data[0];
        if (type === 0) {
            if (base + addr + count > bytes.length) throw Error('HEX超出ATmega328P程序空间');
            for (let i = 0; i < count; i++) {
                const at = base + addr + i;
                if (written.has(at)) throw Error('HEX存在重叠记录');
                bytes[at] = data[4 + i]; written.add(at);
            }
        } else if (type === 1 && count === 0 && addr === 0) end = true;
        else if ((type === 2 || type === 4) && count === 2 && addr === 0) base = (data[4] * 256 + data[5]) * (type === 2 ? 16 : 65536);
        else if (type === 3 || type === 5) throw Error('不支持改变启动地址的HEX');
        else throw Error('HEX记录类型无效');
    }
    if (!end || !written.has(0) || !written.has(1)) throw Error('HEX缺少复位向量或结束记录');
    const words = new Uint16Array(16384);
    for (let i = 0; i < words.length; i++) words[i] = bytes[i * 2] | bytes[i * 2 + 1] << 8;
    return words;
}

export function simulateAiFirmware(firmware: AiFirmware, value: AiAcceptance, progress: (scenario: string) => void = () => {}): AiBehaviorResult {
    const contract = parseAiAcceptance(value), started = performance.now();
    const checks: AiBehaviorCheck[] = [];
    const result = (status: AiBehaviorResult['status'], reason?: string): AiBehaviorResult => ({
        status, contractSha256: aiAcceptanceHash(contract), sourceSha256: firmware.sourceSha256,
        firmwareSha256: firmware.sha256, fqbn: firmware.fqbn, elapsedMs: Math.round(performance.now() - started),
        checks, ...(reason ? { reason } : {}), engine: 'avr8js-0.21.1', hardware: false,
    });
    if (!aiSimulationTarget(firmware.fqbn)) return result('unsupported', '当前仅提供16MHz ATmega328P Uno/Nano指令模拟');
    if (firmware.format !== 'ihex' || sha256Hex(firmware.content) !== firmware.sha256) throw Error('模拟固件内容证明不一致');
    const program = parseAiHex(firmware.content);
    if (!contract.scenarios.length) return result('unsupported', '本次没有可执行的模拟断言');
    try {
        for (const scenario of contract.scenarios) {
            progress(scenario.name);
            const cpu = new CPU(program.slice(), 2048);
            const ports = { B: new AVRIOPort(cpu, portBConfig), C: new AVRIOPort(cpu, portCConfig), D: new AVRIOPort(cpu, portDConfig) };
            new AVRTimer(cpu, timer0Config); new AVRTimer(cpu, timer1Config); new AVRTimer(cpu, timer2Config);
            const serial = new AVRUSART(cpu, usart0Config, 16000000), adc = new AVRADC(cpu, adcConfig);
            const analog = new Map<number, number>();
            const pin = (name: string) => { const n = Number(name.slice(1)); return name.startsWith('A') ? { port: ports.C, bit: n } : n < 8 ? { port: ports.D, bit: n } : { port: ports.B, bit: n - 8 }; };
            const state = (name: string) => { const { port, bit } = pin(name); return port.pinState(bit); };
            const transcript: { at: number; byte: number }[] = [];
            serial.onByteTransmit = byte => {
                if (!(cpu.data[usart0Config.UCSRB] & 0x08) || serial.bitsPerChar !== 8 || (cpu.data[usart0Config.UCSRC] & 0xc0)) throw Error('串口未启用8位异步发送，无法验证输出');
                if (transcript.length >= 32768) throw Error('串口输出超出模拟记录预算');
                transcript.push({ at: cpu.cycles / 16000, byte });
            };
            // Fail closed for a peripheral without a model, including firmware
            // that would otherwise happen to satisfy a weak GPIO assertion.
            for (const [addr, mask, name] of [[0x4c,0x40,'SPI'],[0xbc,0x04,'I²C'],[0x3f,0x07,'EEPROM'],[0x60,0x48,'看门狗'],[0x50,0x08,'模拟比较器'],[0x61,0x0f,'变频时钟'],[0x3d,0x03,'外部中断'],[0x68,0x07,'引脚变化中断']] as const) {
                cpu.writeHooks[addr] = value => { if (value & mask) throw Error(`程序启用了尚未模拟的${name}`); return false; };
            }
            adc.onADCRead = input => {
                if (input.type !== ADCMuxInputType.SingleEnded || adc.referenceVoltageType !== ADCReference.AVCC || !analog.has(input.channel)) throw Error('模拟输入或参考电压未在测试中定义');
                const sample = analog.get(input.channel)!;
                cpu.addClockEvent(() => adc.completeADCRead(sample), adc.sampleCycles);
            };
            const tracked = [...new Set(scenario.assertions.filter(a => a.kind === 'edges').map(a => a.pin))];
            const transitions = new Map(tracked.map(name => [name, [] as number[]]));
            const previous = new Map(tracked.map(name => [name, state(name)]));
            const modes = new Map(tracked.map(name => [name, [{at:0, value:state(name)}]]));
            const observe = () => {
                for (const name of tracked) {
                    const now = state(name), before = previous.get(name)!;
                    if (now <= PinState.High && before <= PinState.High && now !== before) {
                        const rows = transitions.get(name)!;
                        if (rows.length > 20000) throw Error('引脚变化超过记录预算');
                        rows.push(cpu.cycles / 16000);
                    }
                    if (now !== before) {
                        const rows = modes.get(name)!;
                        if (rows.length >= 20000) throw Error('引脚模式变化超过记录预算');
                        rows.push({at:cpu.cycles / 16000,value:now});
                    }
                    previous.set(name, now);
                }
            };
            ports.B.addListener(observe); ports.D.addListener(observe);
            const sampleChecks = new Map<string, number>();
            const scheduled: { cycle: number; order: number; run: () => void }[] = [];
            for (const input of scenario.inputs) scheduled.push({ cycle: input.atMs * 16000, order: 0, run: () => {
                if (input.pin.startsWith('A')) analog.set(Number(input.pin.slice(1)), input.value);
                else { const p = pin(input.pin); p.port.setPin(p.bit, Boolean(input.value)); }
            } });
            for (const a of scenario.assertions) if (a.kind === 'pin') scheduled.push({ cycle: a.atMs * 16000, order: 1, run: () => sampleChecks.set(a.id, state(a.pin)) });
            scheduled.sort((a, b) => a.cycle - b.cycle || a.order - b.order);
            let cursor = 0, iterations = 0;
            const endCycle = scenario.durationMs * 16000;
            while (cpu.cycles < endCycle) {
                while (cursor < scheduled.length && scheduled[cursor].cycle <= cpu.cycles) scheduled[cursor++].run();
                if (cpu.pc >= program.length || cpu.SP < 256 || cpu.SP >= cpu.data.length) throw Error('程序计数器或栈超出ATmega328P空间');
                avrInstruction(cpu); cpu.tick();
                if ((++iterations & 16383) === 0 && performance.now() - started > AI_BEHAVIOR_LIMITS.wallMs) throw Error('指令模拟达到时间预算');
            }
            while (cursor < scheduled.length && scheduled[cursor].cycle <= cpu.cycles) scheduled[cursor++].run();
            for (const a of scenario.assertions) {
                let actual: string, expected: string, ok: boolean;
                if (a.kind === 'pin') {
                    const v = sampleChecks.get(a.id);
                    actual = v === 0 || v === 1 ? String(v) : '未设置为输出'; expected = `${a.pin}在${a.atMs}ms输出${a.value}`; ok = v === a.value;
                } else if (a.kind === 'edges') {
                    const count = transitions.get(a.pin)!.filter(t => t >= a.fromMs && t <= a.toMs).length;
                    const modesInWindow = modes.get(a.pin)!;
                    const initial = modesInWindow.reduce((last, m) => m.at <= a.fromMs ? m : last, modesInWindow[0]);
                    const outputThroughout = initial.value <= PinState.High && modesInWindow.filter(m => m.at > a.fromMs && m.at <= a.toMs).every(m => m.value <= PinState.High);
                    actual = outputThroughout ? `${count}次` : '窗口内未始终设置为输出'; expected = `${a.pin}在${a.fromMs}–${a.toMs}ms变化${a.min}–${a.max}次`; ok = outputThroughout && count >= a.min && count <= a.max;
                } else {
                    const content = new TextDecoder().decode(Uint8Array.from(transcript.filter(t => t.at >= a.fromMs && t.at <= a.toMs), t => t.byte));
                    expected = `串口在${a.fromMs}–${a.toMs}ms包含${JSON.stringify(a.contains)}`; actual = content.slice(-800) || '(无输出)'; ok = content.includes(a.contains);
                }
                checks.push({ scenario: scenario.id, id: a.id, requirement: a.requirement, ok, expected, actual });
            }
        }
        return result(checks.every(c => c.ok) ? 'passed' : 'failed');
    } catch (error) { return result('unsupported', error instanceof Error ? error.message : String(error)); }
}
