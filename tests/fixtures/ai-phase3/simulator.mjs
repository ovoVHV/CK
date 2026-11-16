var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// desktop/apps/desktop/node_modules/avr8js/dist/cjs/cpu/interrupt.js
var require_interrupt = __commonJS({
  "desktop/apps/desktop/node_modules/avr8js/dist/cjs/cpu/interrupt.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.avrInterrupt = avrInterrupt;
    function avrInterrupt(cpu, addr) {
      const sp = cpu.dataView.getUint16(93, true);
      cpu.data[sp] = cpu.pc & 255;
      cpu.data[sp - 1] = cpu.pc >> 8 & 255;
      if (cpu.pc22Bits) {
        cpu.data[sp - 2] = cpu.pc >> 16 & 255;
      }
      cpu.dataView.setUint16(93, sp - (cpu.pc22Bits ? 3 : 2), true);
      cpu.data[95] &= 127;
      cpu.cycles += 2;
      cpu.pc = addr;
    }
  }
});

// desktop/apps/desktop/node_modules/avr8js/dist/cjs/cpu/cpu.js
var require_cpu = __commonJS({
  "desktop/apps/desktop/node_modules/avr8js/dist/cjs/cpu/cpu.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.CPU = void 0;
    var interrupt_1 = require_interrupt();
    var registerSpace = 256;
    var MAX_INTERRUPTS = 128;
    var CPU2 = class {
      constructor(progMem, sramBytes = 8192) {
        this.progMem = progMem;
        this.sramBytes = sramBytes;
        this.data = new Uint8Array(this.sramBytes + registerSpace);
        this.data16 = new Uint16Array(this.data.buffer);
        this.dataView = new DataView(this.data.buffer);
        this.progBytes = new Uint8Array(this.progMem.buffer);
        this.readHooks = [];
        this.writeHooks = [];
        this.pendingInterrupts = new Array(MAX_INTERRUPTS);
        this.nextClockEvent = null;
        this.clockEventPool = [];
        this.pc22Bits = this.progBytes.length > 131072;
        this.gpioPorts = /* @__PURE__ */ new Set();
        this.gpioByPort = [];
        this.onWatchdogReset = () => {
        };
        this.pc = 0;
        this.cycles = 0;
        this.nextInterrupt = -1;
        this.maxInterrupt = 0;
        this.reset();
      }
      reset() {
        this.SP = this.data.length - 1;
        this.pc = 0;
        this.pendingInterrupts.fill(null);
        this.nextInterrupt = -1;
        this.nextClockEvent = null;
      }
      readData(addr) {
        if (addr >= 32 && this.readHooks[addr]) {
          return this.readHooks[addr](addr);
        }
        return this.data[addr];
      }
      writeData(addr, value, mask = 255) {
        const hook = this.writeHooks[addr];
        if (hook) {
          if (hook(value, this.data[addr], addr, mask)) {
            return;
          }
        }
        this.data[addr] = value;
      }
      get SP() {
        return this.dataView.getUint16(93, true);
      }
      set SP(value) {
        this.dataView.setUint16(93, value, true);
      }
      get SREG() {
        return this.data[95];
      }
      get interruptsEnabled() {
        return this.SREG & 128 ? true : false;
      }
      setInterruptFlag(interrupt) {
        const { flagRegister, flagMask, enableRegister, enableMask } = interrupt;
        if (interrupt.inverseFlag) {
          this.data[flagRegister] &= ~flagMask;
        } else {
          this.data[flagRegister] |= flagMask;
        }
        if (this.data[enableRegister] & enableMask) {
          this.queueInterrupt(interrupt);
        }
      }
      updateInterruptEnable(interrupt, registerValue) {
        const { enableMask, flagRegister, flagMask, inverseFlag } = interrupt;
        if (registerValue & enableMask) {
          const bitSet = this.data[flagRegister] & flagMask;
          if (inverseFlag ? !bitSet : bitSet) {
            this.queueInterrupt(interrupt);
          }
        } else {
          this.clearInterrupt(interrupt, false);
        }
      }
      queueInterrupt(interrupt) {
        const { address } = interrupt;
        this.pendingInterrupts[address] = interrupt;
        if (this.nextInterrupt === -1 || this.nextInterrupt > address) {
          this.nextInterrupt = address;
        }
        if (address > this.maxInterrupt) {
          this.maxInterrupt = address;
        }
      }
      clearInterrupt({ address, flagRegister, flagMask }, clearFlag = true) {
        if (clearFlag) {
          this.data[flagRegister] &= ~flagMask;
        }
        const { pendingInterrupts, maxInterrupt } = this;
        if (!pendingInterrupts[address]) {
          return;
        }
        pendingInterrupts[address] = null;
        if (this.nextInterrupt === address) {
          this.nextInterrupt = -1;
          for (let i = address + 1; i <= maxInterrupt; i++) {
            if (pendingInterrupts[i]) {
              this.nextInterrupt = i;
              break;
            }
          }
        }
      }
      clearInterruptByFlag(interrupt, registerValue) {
        const { flagRegister, flagMask } = interrupt;
        if (registerValue & flagMask) {
          this.data[flagRegister] &= ~flagMask;
          this.clearInterrupt(interrupt);
        }
      }
      addClockEvent(callback, cycles) {
        const { clockEventPool } = this;
        cycles = this.cycles + Math.max(1, cycles);
        const maybeEntry = clockEventPool.pop();
        const entry = maybeEntry !== null && maybeEntry !== void 0 ? maybeEntry : { cycles, callback, next: null };
        entry.cycles = cycles;
        entry.callback = callback;
        let { nextClockEvent: clockEvent } = this;
        let lastItem = null;
        while (clockEvent && clockEvent.cycles < cycles) {
          lastItem = clockEvent;
          clockEvent = clockEvent.next;
        }
        if (lastItem) {
          lastItem.next = entry;
          entry.next = clockEvent;
        } else {
          this.nextClockEvent = entry;
          entry.next = clockEvent;
        }
        return callback;
      }
      updateClockEvent(callback, cycles) {
        if (this.clearClockEvent(callback)) {
          this.addClockEvent(callback, cycles);
          return true;
        }
        return false;
      }
      clearClockEvent(callback) {
        let { nextClockEvent: clockEvent } = this;
        if (!clockEvent) {
          return false;
        }
        const { clockEventPool } = this;
        let lastItem = null;
        while (clockEvent) {
          if (clockEvent.callback === callback) {
            if (lastItem) {
              lastItem.next = clockEvent.next;
            } else {
              this.nextClockEvent = clockEvent.next;
            }
            if (clockEventPool.length < 10) {
              clockEventPool.push(clockEvent);
            }
            return true;
          }
          lastItem = clockEvent;
          clockEvent = clockEvent.next;
        }
        return false;
      }
      tick() {
        const { nextClockEvent } = this;
        if (nextClockEvent && nextClockEvent.cycles <= this.cycles) {
          nextClockEvent.callback();
          this.nextClockEvent = nextClockEvent.next;
          if (this.clockEventPool.length < 10) {
            this.clockEventPool.push(nextClockEvent);
          }
        }
        const { nextInterrupt } = this;
        if (this.interruptsEnabled && nextInterrupt >= 0) {
          const interrupt = this.pendingInterrupts[nextInterrupt];
          (0, interrupt_1.avrInterrupt)(this, interrupt.address);
          if (!interrupt.constant) {
            this.clearInterrupt(interrupt);
          }
        }
      }
    };
    exports.CPU = CPU2;
  }
});

// desktop/apps/desktop/node_modules/avr8js/dist/cjs/cpu/instruction.js
var require_instruction = __commonJS({
  "desktop/apps/desktop/node_modules/avr8js/dist/cjs/cpu/instruction.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.avrInstruction = avrInstruction2;
    function isTwoWordInstruction(opcode) {
      return (
        /* LDS */
        (opcode & 65039) === 36864 || /* STS */
        (opcode & 65039) === 37376 || /* CALL */
        (opcode & 65038) === 37902 || /* JMP */
        (opcode & 65038) === 37900
      );
    }
    function avrInstruction2(cpu) {
      const opcode = cpu.progMem[cpu.pc];
      if ((opcode & 64512) === 7168) {
        const d = cpu.data[(opcode & 496) >> 4];
        const r = cpu.data[opcode & 15 | (opcode & 512) >> 5];
        const sum = d + r + (cpu.data[95] & 1);
        const R = sum & 255;
        cpu.data[(opcode & 496) >> 4] = R;
        let sreg = cpu.data[95] & 192;
        sreg |= R ? 0 : 2;
        sreg |= 128 & R ? 4 : 0;
        sreg |= (R ^ r) & (d ^ R) & 128 ? 8 : 0;
        sreg |= sreg >> 2 & 1 ^ sreg >> 3 & 1 ? 16 : 0;
        sreg |= sum & 256 ? 1 : 0;
        sreg |= 1 & (d & r | r & ~R | ~R & d) ? 32 : 0;
        cpu.data[95] = sreg;
      } else if ((opcode & 64512) === 3072) {
        const d = cpu.data[(opcode & 496) >> 4];
        const r = cpu.data[opcode & 15 | (opcode & 512) >> 5];
        const R = d + r & 255;
        cpu.data[(opcode & 496) >> 4] = R;
        let sreg = cpu.data[95] & 192;
        sreg |= R ? 0 : 2;
        sreg |= 128 & R ? 4 : 0;
        sreg |= (R ^ r) & (R ^ d) & 128 ? 8 : 0;
        sreg |= sreg >> 2 & 1 ^ sreg >> 3 & 1 ? 16 : 0;
        sreg |= d + r & 256 ? 1 : 0;
        sreg |= 1 & (d & r | r & ~R | ~R & d) ? 32 : 0;
        cpu.data[95] = sreg;
      } else if ((opcode & 65280) === 38400) {
        const addr = 2 * ((opcode & 48) >> 4) + 24;
        const value = cpu.dataView.getUint16(addr, true);
        const R = value + (opcode & 15 | (opcode & 192) >> 2) & 65535;
        cpu.dataView.setUint16(addr, R, true);
        let sreg = cpu.data[95] & 224;
        sreg |= R ? 0 : 2;
        sreg |= 32768 & R ? 4 : 0;
        sreg |= ~value & R & 32768 ? 8 : 0;
        sreg |= sreg >> 2 & 1 ^ sreg >> 3 & 1 ? 16 : 0;
        sreg |= ~R & value & 32768 ? 1 : 0;
        cpu.data[95] = sreg;
        cpu.cycles++;
      } else if ((opcode & 64512) === 8192) {
        const R = cpu.data[(opcode & 496) >> 4] & cpu.data[opcode & 15 | (opcode & 512) >> 5];
        cpu.data[(opcode & 496) >> 4] = R;
        let sreg = cpu.data[95] & 225;
        sreg |= R ? 0 : 2;
        sreg |= 128 & R ? 4 : 0;
        sreg |= sreg >> 2 & 1 ^ sreg >> 3 & 1 ? 16 : 0;
        cpu.data[95] = sreg;
      } else if ((opcode & 61440) === 28672) {
        const R = cpu.data[((opcode & 240) >> 4) + 16] & (opcode & 15 | (opcode & 3840) >> 4);
        cpu.data[((opcode & 240) >> 4) + 16] = R;
        let sreg = cpu.data[95] & 225;
        sreg |= R ? 0 : 2;
        sreg |= 128 & R ? 4 : 0;
        sreg |= sreg >> 2 & 1 ^ sreg >> 3 & 1 ? 16 : 0;
        cpu.data[95] = sreg;
      } else if ((opcode & 65039) === 37893) {
        const value = cpu.data[(opcode & 496) >> 4];
        const R = value >>> 1 | 128 & value;
        cpu.data[(opcode & 496) >> 4] = R;
        let sreg = cpu.data[95] & 224;
        sreg |= R ? 0 : 2;
        sreg |= 128 & R ? 4 : 0;
        sreg |= value & 1;
        sreg |= sreg >> 2 & 1 ^ sreg & 1 ? 8 : 0;
        sreg |= sreg >> 2 & 1 ^ sreg >> 3 & 1 ? 16 : 0;
        cpu.data[95] = sreg;
      } else if ((opcode & 65423) === 38024) {
        cpu.data[95] &= ~(1 << ((opcode & 112) >> 4));
      } else if ((opcode & 65032) === 63488) {
        const b = opcode & 7;
        const d = (opcode & 496) >> 4;
        cpu.data[d] = ~(1 << b) & cpu.data[d] | (cpu.data[95] >> 6 & 1) << b;
      } else if ((opcode & 64512) === 62464) {
        if (!(cpu.data[95] & 1 << (opcode & 7))) {
          cpu.pc = cpu.pc + (((opcode & 504) >> 3) - (opcode & 512 ? 64 : 0));
          cpu.cycles++;
        }
      } else if ((opcode & 64512) === 61440) {
        if (cpu.data[95] & 1 << (opcode & 7)) {
          cpu.pc = cpu.pc + (((opcode & 504) >> 3) - (opcode & 512 ? 64 : 0));
          cpu.cycles++;
        }
      } else if ((opcode & 65423) === 37896) {
        cpu.data[95] |= 1 << ((opcode & 112) >> 4);
      } else if ((opcode & 65032) === 64e3) {
        const d = cpu.data[(opcode & 496) >> 4];
        const b = opcode & 7;
        cpu.data[95] = cpu.data[95] & 191 | (d >> b & 1 ? 64 : 0);
      } else if ((opcode & 65038) === 37902) {
        const k = cpu.progMem[cpu.pc + 1] | (opcode & 1) << 16 | (opcode & 496) << 13;
        const ret = cpu.pc + 2;
        const sp = cpu.dataView.getUint16(93, true);
        const { pc22Bits } = cpu;
        cpu.data[sp] = 255 & ret;
        cpu.data[sp - 1] = ret >> 8 & 255;
        if (pc22Bits) {
          cpu.data[sp - 2] = ret >> 16 & 255;
        }
        cpu.dataView.setUint16(93, sp - (pc22Bits ? 3 : 2), true);
        cpu.pc = k - 1;
        cpu.cycles += pc22Bits ? 4 : 3;
      } else if ((opcode & 65280) === 38912) {
        const A = opcode & 248;
        const b = opcode & 7;
        const R = cpu.readData((A >> 3) + 32);
        const mask = 1 << b;
        cpu.writeData((A >> 3) + 32, R & ~mask, mask);
      } else if ((opcode & 65039) === 37888) {
        const d = (opcode & 496) >> 4;
        const R = 255 - cpu.data[d];
        cpu.data[d] = R;
        let sreg = cpu.data[95] & 225 | 1;
        sreg |= R ? 0 : 2;
        sreg |= 128 & R ? 4 : 0;
        sreg |= sreg >> 2 & 1 ^ sreg >> 3 & 1 ? 16 : 0;
        cpu.data[95] = sreg;
      } else if ((opcode & 64512) === 5120) {
        const val1 = cpu.data[(opcode & 496) >> 4];
        const val2 = cpu.data[opcode & 15 | (opcode & 512) >> 5];
        const R = val1 - val2;
        let sreg = cpu.data[95] & 192;
        sreg |= R ? 0 : 2;
        sreg |= 128 & R ? 4 : 0;
        sreg |= 0 !== ((val1 ^ val2) & (val1 ^ R) & 128) ? 8 : 0;
        sreg |= sreg >> 2 & 1 ^ sreg >> 3 & 1 ? 16 : 0;
        sreg |= val2 > val1 ? 1 : 0;
        sreg |= 1 & (~val1 & val2 | val2 & R | R & ~val1) ? 32 : 0;
        cpu.data[95] = sreg;
      } else if ((opcode & 64512) === 1024) {
        const arg1 = cpu.data[(opcode & 496) >> 4];
        const arg2 = cpu.data[opcode & 15 | (opcode & 512) >> 5];
        let sreg = cpu.data[95];
        const r = arg1 - arg2 - (sreg & 1);
        sreg = sreg & 192 | (!r && sreg >> 1 & 1 ? 2 : 0) | (arg2 + (sreg & 1) > arg1 ? 1 : 0);
        sreg |= 128 & r ? 4 : 0;
        sreg |= (arg1 ^ arg2) & (arg1 ^ r) & 128 ? 8 : 0;
        sreg |= sreg >> 2 & 1 ^ sreg >> 3 & 1 ? 16 : 0;
        sreg |= 1 & (~arg1 & arg2 | arg2 & r | r & ~arg1) ? 32 : 0;
        cpu.data[95] = sreg;
      } else if ((opcode & 61440) === 12288) {
        const arg1 = cpu.data[((opcode & 240) >> 4) + 16];
        const arg2 = opcode & 15 | (opcode & 3840) >> 4;
        const r = arg1 - arg2;
        let sreg = cpu.data[95] & 192;
        sreg |= r ? 0 : 2;
        sreg |= 128 & r ? 4 : 0;
        sreg |= (arg1 ^ arg2) & (arg1 ^ r) & 128 ? 8 : 0;
        sreg |= sreg >> 2 & 1 ^ sreg >> 3 & 1 ? 16 : 0;
        sreg |= arg2 > arg1 ? 1 : 0;
        sreg |= 1 & (~arg1 & arg2 | arg2 & r | r & ~arg1) ? 32 : 0;
        cpu.data[95] = sreg;
      } else if ((opcode & 64512) === 4096) {
        if (cpu.data[(opcode & 496) >> 4] === cpu.data[opcode & 15 | (opcode & 512) >> 5]) {
          const nextOpcode = cpu.progMem[cpu.pc + 1];
          const skipSize = isTwoWordInstruction(nextOpcode) ? 2 : 1;
          cpu.pc += skipSize;
          cpu.cycles += skipSize;
        }
      } else if ((opcode & 65039) === 37898) {
        const value = cpu.data[(opcode & 496) >> 4];
        const R = value - 1;
        cpu.data[(opcode & 496) >> 4] = R;
        let sreg = cpu.data[95] & 225;
        sreg |= R ? 0 : 2;
        sreg |= 128 & R ? 4 : 0;
        sreg |= 128 === value ? 8 : 0;
        sreg |= sreg >> 2 & 1 ^ sreg >> 3 & 1 ? 16 : 0;
        cpu.data[95] = sreg;
      } else if (opcode === 38169) {
        const retAddr = cpu.pc + 1;
        const sp = cpu.dataView.getUint16(93, true);
        const eind = cpu.data[92];
        cpu.data[sp] = retAddr & 255;
        cpu.data[sp - 1] = retAddr >> 8 & 255;
        cpu.data[sp - 2] = retAddr >> 16 & 255;
        cpu.dataView.setUint16(93, sp - 3, true);
        cpu.pc = (eind << 16 | cpu.dataView.getUint16(30, true)) - 1;
        cpu.cycles += 3;
      } else if (opcode === 37913) {
        const eind = cpu.data[92];
        cpu.pc = (eind << 16 | cpu.dataView.getUint16(30, true)) - 1;
        cpu.cycles++;
      } else if (opcode === 38360) {
        const rampz = cpu.data[91];
        cpu.data[0] = cpu.progBytes[rampz << 16 | cpu.dataView.getUint16(30, true)];
        cpu.cycles += 2;
      } else if ((opcode & 65039) === 36870) {
        const rampz = cpu.data[91];
        cpu.data[(opcode & 496) >> 4] = cpu.progBytes[rampz << 16 | cpu.dataView.getUint16(30, true)];
        cpu.cycles += 2;
      } else if ((opcode & 65039) === 36871) {
        const rampz = cpu.data[91];
        const i = cpu.dataView.getUint16(30, true);
        cpu.data[(opcode & 496) >> 4] = cpu.progBytes[rampz << 16 | i];
        cpu.dataView.setUint16(30, i + 1, true);
        if (i === 65535) {
          cpu.data[91] = (rampz + 1) % (cpu.progBytes.length >> 16);
        }
        cpu.cycles += 2;
      } else if ((opcode & 64512) === 9216) {
        const R = cpu.data[(opcode & 496) >> 4] ^ cpu.data[opcode & 15 | (opcode & 512) >> 5];
        cpu.data[(opcode & 496) >> 4] = R;
        let sreg = cpu.data[95] & 225;
        sreg |= R ? 0 : 2;
        sreg |= 128 & R ? 4 : 0;
        sreg |= sreg >> 2 & 1 ^ sreg >> 3 & 1 ? 16 : 0;
        cpu.data[95] = sreg;
      } else if ((opcode & 65416) === 776) {
        const v1 = cpu.data[((opcode & 112) >> 4) + 16];
        const v2 = cpu.data[(opcode & 7) + 16];
        const R = v1 * v2 << 1;
        cpu.dataView.setUint16(0, R, true);
        cpu.data[95] = cpu.data[95] & 252 | (65535 & R ? 0 : 2) | (v1 * v2 & 32768 ? 1 : 0);
        cpu.cycles++;
      } else if ((opcode & 65416) === 896) {
        const v1 = cpu.dataView.getInt8(((opcode & 112) >> 4) + 16);
        const v2 = cpu.dataView.getInt8((opcode & 7) + 16);
        const R = v1 * v2 << 1;
        cpu.dataView.setInt16(0, R, true);
        cpu.data[95] = cpu.data[95] & 252 | (65535 & R ? 0 : 2) | (v1 * v2 & 32768 ? 1 : 0);
        cpu.cycles++;
      } else if ((opcode & 65416) === 904) {
        const v1 = cpu.dataView.getInt8(((opcode & 112) >> 4) + 16);
        const v2 = cpu.data[(opcode & 7) + 16];
        const R = v1 * v2 << 1;
        cpu.dataView.setInt16(0, R, true);
        cpu.data[95] = cpu.data[95] & 252 | (65535 & R ? 2 : 0) | (v1 * v2 & 32768 ? 1 : 0);
        cpu.cycles++;
      } else if (opcode === 38153) {
        const retAddr = cpu.pc + 1;
        const sp = cpu.dataView.getUint16(93, true);
        const { pc22Bits } = cpu;
        cpu.data[sp] = retAddr & 255;
        cpu.data[sp - 1] = retAddr >> 8 & 255;
        if (pc22Bits) {
          cpu.data[sp - 2] = retAddr >> 16 & 255;
        }
        cpu.dataView.setUint16(93, sp - (pc22Bits ? 3 : 2), true);
        cpu.pc = cpu.dataView.getUint16(30, true) - 1;
        cpu.cycles += pc22Bits ? 3 : 2;
      } else if (opcode === 37897) {
        cpu.pc = cpu.dataView.getUint16(30, true) - 1;
        cpu.cycles++;
      } else if ((opcode & 63488) === 45056) {
        const i = cpu.readData((opcode & 15 | (opcode & 1536) >> 5) + 32);
        cpu.data[(opcode & 496) >> 4] = i;
      } else if ((opcode & 65039) === 37891) {
        const d = cpu.data[(opcode & 496) >> 4];
        const r = d + 1 & 255;
        cpu.data[(opcode & 496) >> 4] = r;
        let sreg = cpu.data[95] & 225;
        sreg |= r ? 0 : 2;
        sreg |= 128 & r ? 4 : 0;
        sreg |= 127 === d ? 8 : 0;
        sreg |= sreg >> 2 & 1 ^ sreg >> 3 & 1 ? 16 : 0;
        cpu.data[95] = sreg;
      } else if ((opcode & 65038) === 37900) {
        cpu.pc = (cpu.progMem[cpu.pc + 1] | (opcode & 1) << 16 | (opcode & 496) << 13) - 1;
        cpu.cycles += 2;
      } else if ((opcode & 65039) === 37382) {
        const r = (opcode & 496) >> 4;
        const clear = cpu.data[r];
        const value = cpu.readData(cpu.dataView.getUint16(30, true));
        cpu.writeData(cpu.dataView.getUint16(30, true), value & 255 - clear);
        cpu.data[r] = value;
      } else if ((opcode & 65039) === 37381) {
        const r = (opcode & 496) >> 4;
        const set = cpu.data[r];
        const value = cpu.readData(cpu.dataView.getUint16(30, true));
        cpu.writeData(cpu.dataView.getUint16(30, true), value | set);
        cpu.data[r] = value;
      } else if ((opcode & 65039) === 37383) {
        const r = cpu.data[(opcode & 496) >> 4];
        const R = cpu.readData(cpu.dataView.getUint16(30, true));
        cpu.writeData(cpu.dataView.getUint16(30, true), r ^ R);
        cpu.data[(opcode & 496) >> 4] = R;
      } else if ((opcode & 61440) === 57344) {
        cpu.data[((opcode & 240) >> 4) + 16] = opcode & 15 | (opcode & 3840) >> 4;
      } else if ((opcode & 65039) === 36864) {
        cpu.cycles++;
        const value = cpu.readData(cpu.progMem[cpu.pc + 1]);
        cpu.data[(opcode & 496) >> 4] = value;
        cpu.pc++;
      } else if ((opcode & 65039) === 36876) {
        cpu.cycles++;
        cpu.data[(opcode & 496) >> 4] = cpu.readData(cpu.dataView.getUint16(26, true));
      } else if ((opcode & 65039) === 36877) {
        const x = cpu.dataView.getUint16(26, true);
        cpu.cycles++;
        cpu.data[(opcode & 496) >> 4] = cpu.readData(x);
        cpu.dataView.setUint16(26, x + 1, true);
      } else if ((opcode & 65039) === 36878) {
        const x = cpu.dataView.getUint16(26, true) - 1;
        cpu.dataView.setUint16(26, x, true);
        cpu.cycles++;
        cpu.data[(opcode & 496) >> 4] = cpu.readData(x);
      } else if ((opcode & 65039) === 32776) {
        cpu.cycles++;
        cpu.data[(opcode & 496) >> 4] = cpu.readData(cpu.dataView.getUint16(28, true));
      } else if ((opcode & 65039) === 36873) {
        const y = cpu.dataView.getUint16(28, true);
        cpu.cycles++;
        cpu.data[(opcode & 496) >> 4] = cpu.readData(y);
        cpu.dataView.setUint16(28, y + 1, true);
      } else if ((opcode & 65039) === 36874) {
        const y = cpu.dataView.getUint16(28, true) - 1;
        cpu.dataView.setUint16(28, y, true);
        cpu.cycles++;
        cpu.data[(opcode & 496) >> 4] = cpu.readData(y);
      } else if ((opcode & 53768) === 32776 && opcode & 7 | (opcode & 3072) >> 7 | (opcode & 8192) >> 8) {
        cpu.cycles++;
        cpu.data[(opcode & 496) >> 4] = cpu.readData(cpu.dataView.getUint16(28, true) + (opcode & 7 | (opcode & 3072) >> 7 | (opcode & 8192) >> 8));
      } else if ((opcode & 65039) === 32768) {
        cpu.cycles++;
        cpu.data[(opcode & 496) >> 4] = cpu.readData(cpu.dataView.getUint16(30, true));
      } else if ((opcode & 65039) === 36865) {
        const z = cpu.dataView.getUint16(30, true);
        cpu.cycles++;
        cpu.data[(opcode & 496) >> 4] = cpu.readData(z);
        cpu.dataView.setUint16(30, z + 1, true);
      } else if ((opcode & 65039) === 36866) {
        const z = cpu.dataView.getUint16(30, true) - 1;
        cpu.dataView.setUint16(30, z, true);
        cpu.cycles++;
        cpu.data[(opcode & 496) >> 4] = cpu.readData(z);
      } else if ((opcode & 53768) === 32768 && opcode & 7 | (opcode & 3072) >> 7 | (opcode & 8192) >> 8) {
        cpu.cycles++;
        cpu.data[(opcode & 496) >> 4] = cpu.readData(cpu.dataView.getUint16(30, true) + (opcode & 7 | (opcode & 3072) >> 7 | (opcode & 8192) >> 8));
      } else if (opcode === 38344) {
        cpu.data[0] = cpu.progBytes[cpu.dataView.getUint16(30, true)];
        cpu.cycles += 2;
      } else if ((opcode & 65039) === 36868) {
        cpu.data[(opcode & 496) >> 4] = cpu.progBytes[cpu.dataView.getUint16(30, true)];
        cpu.cycles += 2;
      } else if ((opcode & 65039) === 36869) {
        const i = cpu.dataView.getUint16(30, true);
        cpu.data[(opcode & 496) >> 4] = cpu.progBytes[i];
        cpu.dataView.setUint16(30, i + 1, true);
        cpu.cycles += 2;
      } else if ((opcode & 65039) === 37894) {
        const value = cpu.data[(opcode & 496) >> 4];
        const R = value >>> 1;
        cpu.data[(opcode & 496) >> 4] = R;
        let sreg = cpu.data[95] & 224;
        sreg |= R ? 0 : 2;
        sreg |= value & 1;
        sreg |= sreg >> 2 & 1 ^ sreg & 1 ? 8 : 0;
        sreg |= sreg >> 2 & 1 ^ sreg >> 3 & 1 ? 16 : 0;
        cpu.data[95] = sreg;
      } else if ((opcode & 64512) === 11264) {
        cpu.data[(opcode & 496) >> 4] = cpu.data[opcode & 15 | (opcode & 512) >> 5];
      } else if ((opcode & 65280) === 256) {
        const r2 = 2 * (opcode & 15);
        const d2 = 2 * ((opcode & 240) >> 4);
        cpu.data[d2] = cpu.data[r2];
        cpu.data[d2 + 1] = cpu.data[r2 + 1];
      } else if ((opcode & 64512) === 39936) {
        const R = cpu.data[(opcode & 496) >> 4] * cpu.data[opcode & 15 | (opcode & 512) >> 5];
        cpu.dataView.setUint16(0, R, true);
        cpu.data[95] = cpu.data[95] & 252 | (65535 & R ? 0 : 2) | (32768 & R ? 1 : 0);
        cpu.cycles++;
      } else if ((opcode & 65280) === 512) {
        const R = cpu.dataView.getInt8(((opcode & 240) >> 4) + 16) * cpu.dataView.getInt8((opcode & 15) + 16);
        cpu.dataView.setInt16(0, R, true);
        cpu.data[95] = cpu.data[95] & 252 | (65535 & R ? 0 : 2) | (32768 & R ? 1 : 0);
        cpu.cycles++;
      } else if ((opcode & 65416) === 768) {
        const R = cpu.dataView.getInt8(((opcode & 112) >> 4) + 16) * cpu.data[(opcode & 7) + 16];
        cpu.dataView.setInt16(0, R, true);
        cpu.data[95] = cpu.data[95] & 252 | (65535 & R ? 0 : 2) | (32768 & R ? 1 : 0);
        cpu.cycles++;
      } else if ((opcode & 65039) === 37889) {
        const d = (opcode & 496) >> 4;
        const value = cpu.data[d];
        const R = 0 - value;
        cpu.data[d] = R;
        let sreg = cpu.data[95] & 192;
        sreg |= R ? 0 : 2;
        sreg |= 128 & R ? 4 : 0;
        sreg |= 128 === R ? 8 : 0;
        sreg |= sreg >> 2 & 1 ^ sreg >> 3 & 1 ? 16 : 0;
        sreg |= R ? 1 : 0;
        sreg |= 1 & (R | value) ? 32 : 0;
        cpu.data[95] = sreg;
      } else if (opcode === 0) {
      } else if ((opcode & 64512) === 10240) {
        const R = cpu.data[(opcode & 496) >> 4] | cpu.data[opcode & 15 | (opcode & 512) >> 5];
        cpu.data[(opcode & 496) >> 4] = R;
        let sreg = cpu.data[95] & 225;
        sreg |= R ? 0 : 2;
        sreg |= 128 & R ? 4 : 0;
        sreg |= sreg >> 2 & 1 ^ sreg >> 3 & 1 ? 16 : 0;
        cpu.data[95] = sreg;
      } else if ((opcode & 61440) === 24576) {
        const R = cpu.data[((opcode & 240) >> 4) + 16] | (opcode & 15 | (opcode & 3840) >> 4);
        cpu.data[((opcode & 240) >> 4) + 16] = R;
        let sreg = cpu.data[95] & 225;
        sreg |= R ? 0 : 2;
        sreg |= 128 & R ? 4 : 0;
        sreg |= sreg >> 2 & 1 ^ sreg >> 3 & 1 ? 16 : 0;
        cpu.data[95] = sreg;
      } else if ((opcode & 63488) === 47104) {
        cpu.writeData((opcode & 15 | (opcode & 1536) >> 5) + 32, cpu.data[(opcode & 496) >> 4]);
      } else if ((opcode & 65039) === 36879) {
        const value = cpu.dataView.getUint16(93, true) + 1;
        cpu.dataView.setUint16(93, value, true);
        cpu.data[(opcode & 496) >> 4] = cpu.data[value];
        cpu.cycles++;
      } else if ((opcode & 65039) === 37391) {
        const value = cpu.dataView.getUint16(93, true);
        cpu.data[value] = cpu.data[(opcode & 496) >> 4];
        cpu.dataView.setUint16(93, value - 1, true);
        cpu.cycles++;
      } else if ((opcode & 61440) === 53248) {
        const k = (opcode & 2047) - (opcode & 2048 ? 2048 : 0);
        const retAddr = cpu.pc + 1;
        const sp = cpu.dataView.getUint16(93, true);
        const { pc22Bits } = cpu;
        cpu.data[sp] = 255 & retAddr;
        cpu.data[sp - 1] = retAddr >> 8 & 255;
        if (pc22Bits) {
          cpu.data[sp - 2] = retAddr >> 16 & 255;
        }
        cpu.dataView.setUint16(93, sp - (pc22Bits ? 3 : 2), true);
        cpu.pc += k;
        cpu.cycles += pc22Bits ? 3 : 2;
      } else if (opcode === 38152) {
        const { pc22Bits } = cpu;
        const i = cpu.dataView.getUint16(93, true) + (pc22Bits ? 3 : 2);
        cpu.dataView.setUint16(93, i, true);
        cpu.pc = (cpu.data[i - 1] << 8) + cpu.data[i] - 1;
        if (pc22Bits) {
          cpu.pc |= cpu.data[i - 2] << 16;
        }
        cpu.cycles += pc22Bits ? 4 : 3;
      } else if (opcode === 38168) {
        const { pc22Bits } = cpu;
        const i = cpu.dataView.getUint16(93, true) + (pc22Bits ? 3 : 2);
        cpu.dataView.setUint16(93, i, true);
        cpu.pc = (cpu.data[i - 1] << 8) + cpu.data[i] - 1;
        if (pc22Bits) {
          cpu.pc |= cpu.data[i - 2] << 16;
        }
        cpu.cycles += pc22Bits ? 4 : 3;
        cpu.data[95] |= 128;
      } else if ((opcode & 61440) === 49152) {
        cpu.pc = cpu.pc + ((opcode & 2047) - (opcode & 2048 ? 2048 : 0));
        cpu.cycles++;
      } else if ((opcode & 65039) === 37895) {
        const d = cpu.data[(opcode & 496) >> 4];
        const r = d >>> 1 | (cpu.data[95] & 1) << 7;
        cpu.data[(opcode & 496) >> 4] = r;
        let sreg = cpu.data[95] & 224;
        sreg |= r ? 0 : 2;
        sreg |= 128 & r ? 4 : 0;
        sreg |= 1 & d ? 1 : 0;
        sreg |= sreg >> 2 & 1 ^ sreg & 1 ? 8 : 0;
        sreg |= sreg >> 2 & 1 ^ sreg >> 3 & 1 ? 16 : 0;
        cpu.data[95] = sreg;
      } else if ((opcode & 64512) === 2048) {
        const val1 = cpu.data[(opcode & 496) >> 4];
        const val2 = cpu.data[opcode & 15 | (opcode & 512) >> 5];
        let sreg = cpu.data[95];
        const R = val1 - val2 - (sreg & 1);
        cpu.data[(opcode & 496) >> 4] = R;
        sreg = sreg & 192 | (!R && sreg >> 1 & 1 ? 2 : 0) | (val2 + (sreg & 1) > val1 ? 1 : 0);
        sreg |= 128 & R ? 4 : 0;
        sreg |= (val1 ^ val2) & (val1 ^ R) & 128 ? 8 : 0;
        sreg |= sreg >> 2 & 1 ^ sreg >> 3 & 1 ? 16 : 0;
        sreg |= 1 & (~val1 & val2 | val2 & R | R & ~val1) ? 32 : 0;
        cpu.data[95] = sreg;
      } else if ((opcode & 61440) === 16384) {
        const val1 = cpu.data[((opcode & 240) >> 4) + 16];
        const val2 = opcode & 15 | (opcode & 3840) >> 4;
        let sreg = cpu.data[95];
        const R = val1 - val2 - (sreg & 1);
        cpu.data[((opcode & 240) >> 4) + 16] = R;
        sreg = sreg & 192 | (!R && sreg >> 1 & 1 ? 2 : 0) | (val2 + (sreg & 1) > val1 ? 1 : 0);
        sreg |= 128 & R ? 4 : 0;
        sreg |= (val1 ^ val2) & (val1 ^ R) & 128 ? 8 : 0;
        sreg |= sreg >> 2 & 1 ^ sreg >> 3 & 1 ? 16 : 0;
        sreg |= 1 & (~val1 & val2 | val2 & R | R & ~val1) ? 32 : 0;
        cpu.data[95] = sreg;
      } else if ((opcode & 65280) === 39424) {
        const target = ((opcode & 248) >> 3) + 32;
        const mask = 1 << (opcode & 7);
        cpu.writeData(target, cpu.readData(target) | mask, mask);
        cpu.cycles++;
      } else if ((opcode & 65280) === 39168) {
        const value = cpu.readData(((opcode & 248) >> 3) + 32);
        if (!(value & 1 << (opcode & 7))) {
          const nextOpcode = cpu.progMem[cpu.pc + 1];
          const skipSize = isTwoWordInstruction(nextOpcode) ? 2 : 1;
          cpu.cycles += skipSize;
          cpu.pc += skipSize;
        }
      } else if ((opcode & 65280) === 39680) {
        const value = cpu.readData(((opcode & 248) >> 3) + 32);
        if (value & 1 << (opcode & 7)) {
          const nextOpcode = cpu.progMem[cpu.pc + 1];
          const skipSize = isTwoWordInstruction(nextOpcode) ? 2 : 1;
          cpu.cycles += skipSize;
          cpu.pc += skipSize;
        }
      } else if ((opcode & 65280) === 38656) {
        const i = 2 * ((opcode & 48) >> 4) + 24;
        const a = cpu.dataView.getUint16(i, true);
        const l = opcode & 15 | (opcode & 192) >> 2;
        const R = a - l;
        cpu.dataView.setUint16(i, R, true);
        let sreg = cpu.data[95] & 192;
        sreg |= R ? 0 : 2;
        sreg |= 32768 & R ? 4 : 0;
        sreg |= a & ~R & 32768 ? 8 : 0;
        sreg |= sreg >> 2 & 1 ^ sreg >> 3 & 1 ? 16 : 0;
        sreg |= l > a ? 1 : 0;
        sreg |= 1 & (~a & l | l & R | R & ~a) ? 32 : 0;
        cpu.data[95] = sreg;
        cpu.cycles++;
      } else if ((opcode & 65032) === 64512) {
        if (!(cpu.data[(opcode & 496) >> 4] & 1 << (opcode & 7))) {
          const nextOpcode = cpu.progMem[cpu.pc + 1];
          const skipSize = isTwoWordInstruction(nextOpcode) ? 2 : 1;
          cpu.cycles += skipSize;
          cpu.pc += skipSize;
        }
      } else if ((opcode & 65032) === 65024) {
        if (cpu.data[(opcode & 496) >> 4] & 1 << (opcode & 7)) {
          const nextOpcode = cpu.progMem[cpu.pc + 1];
          const skipSize = isTwoWordInstruction(nextOpcode) ? 2 : 1;
          cpu.cycles += skipSize;
          cpu.pc += skipSize;
        }
      } else if (opcode === 38280) {
      } else if (opcode === 38376) {
      } else if (opcode === 38392) {
      } else if ((opcode & 65039) === 37376) {
        const value = cpu.data[(opcode & 496) >> 4];
        const addr = cpu.progMem[cpu.pc + 1];
        cpu.writeData(addr, value);
        cpu.pc++;
        cpu.cycles++;
      } else if ((opcode & 65039) === 37388) {
        cpu.writeData(cpu.dataView.getUint16(26, true), cpu.data[(opcode & 496) >> 4]);
        cpu.cycles++;
      } else if ((opcode & 65039) === 37389) {
        const x = cpu.dataView.getUint16(26, true);
        cpu.writeData(x, cpu.data[(opcode & 496) >> 4]);
        cpu.dataView.setUint16(26, x + 1, true);
        cpu.cycles++;
      } else if ((opcode & 65039) === 37390) {
        const i = cpu.data[(opcode & 496) >> 4];
        const x = cpu.dataView.getUint16(26, true) - 1;
        cpu.dataView.setUint16(26, x, true);
        cpu.writeData(x, i);
        cpu.cycles++;
      } else if ((opcode & 65039) === 33288) {
        cpu.writeData(cpu.dataView.getUint16(28, true), cpu.data[(opcode & 496) >> 4]);
        cpu.cycles++;
      } else if ((opcode & 65039) === 37385) {
        const i = cpu.data[(opcode & 496) >> 4];
        const y = cpu.dataView.getUint16(28, true);
        cpu.writeData(y, i);
        cpu.dataView.setUint16(28, y + 1, true);
        cpu.cycles++;
      } else if ((opcode & 65039) === 37386) {
        const i = cpu.data[(opcode & 496) >> 4];
        const y = cpu.dataView.getUint16(28, true) - 1;
        cpu.dataView.setUint16(28, y, true);
        cpu.writeData(y, i);
        cpu.cycles++;
      } else if ((opcode & 53768) === 33288 && opcode & 7 | (opcode & 3072) >> 7 | (opcode & 8192) >> 8) {
        cpu.writeData(cpu.dataView.getUint16(28, true) + (opcode & 7 | (opcode & 3072) >> 7 | (opcode & 8192) >> 8), cpu.data[(opcode & 496) >> 4]);
        cpu.cycles++;
      } else if ((opcode & 65039) === 33280) {
        cpu.writeData(cpu.dataView.getUint16(30, true), cpu.data[(opcode & 496) >> 4]);
        cpu.cycles++;
      } else if ((opcode & 65039) === 37377) {
        const z = cpu.dataView.getUint16(30, true);
        cpu.writeData(z, cpu.data[(opcode & 496) >> 4]);
        cpu.dataView.setUint16(30, z + 1, true);
        cpu.cycles++;
      } else if ((opcode & 65039) === 37378) {
        const i = cpu.data[(opcode & 496) >> 4];
        const z = cpu.dataView.getUint16(30, true) - 1;
        cpu.dataView.setUint16(30, z, true);
        cpu.writeData(z, i);
        cpu.cycles++;
      } else if ((opcode & 53768) === 33280 && opcode & 7 | (opcode & 3072) >> 7 | (opcode & 8192) >> 8) {
        cpu.writeData(cpu.dataView.getUint16(30, true) + (opcode & 7 | (opcode & 3072) >> 7 | (opcode & 8192) >> 8), cpu.data[(opcode & 496) >> 4]);
        cpu.cycles++;
      } else if ((opcode & 64512) === 6144) {
        const val1 = cpu.data[(opcode & 496) >> 4];
        const val2 = cpu.data[opcode & 15 | (opcode & 512) >> 5];
        const R = val1 - val2;
        cpu.data[(opcode & 496) >> 4] = R;
        let sreg = cpu.data[95] & 192;
        sreg |= R ? 0 : 2;
        sreg |= 128 & R ? 4 : 0;
        sreg |= (val1 ^ val2) & (val1 ^ R) & 128 ? 8 : 0;
        sreg |= sreg >> 2 & 1 ^ sreg >> 3 & 1 ? 16 : 0;
        sreg |= val2 > val1 ? 1 : 0;
        sreg |= 1 & (~val1 & val2 | val2 & R | R & ~val1) ? 32 : 0;
        cpu.data[95] = sreg;
      } else if ((opcode & 61440) === 20480) {
        const val1 = cpu.data[((opcode & 240) >> 4) + 16];
        const val2 = opcode & 15 | (opcode & 3840) >> 4;
        const R = val1 - val2;
        cpu.data[((opcode & 240) >> 4) + 16] = R;
        let sreg = cpu.data[95] & 192;
        sreg |= R ? 0 : 2;
        sreg |= 128 & R ? 4 : 0;
        sreg |= (val1 ^ val2) & (val1 ^ R) & 128 ? 8 : 0;
        sreg |= sreg >> 2 & 1 ^ sreg >> 3 & 1 ? 16 : 0;
        sreg |= val2 > val1 ? 1 : 0;
        sreg |= 1 & (~val1 & val2 | val2 & R | R & ~val1) ? 32 : 0;
        cpu.data[95] = sreg;
      } else if ((opcode & 65039) === 37890) {
        const d = (opcode & 496) >> 4;
        const i = cpu.data[d];
        cpu.data[d] = (15 & i) << 4 | (240 & i) >>> 4;
      } else if (opcode === 38312) {
        cpu.onWatchdogReset();
      } else if ((opcode & 65039) === 37380) {
        const r = (opcode & 496) >> 4;
        const val1 = cpu.data[r];
        const val2 = cpu.data[cpu.dataView.getUint16(30, true)];
        cpu.data[cpu.dataView.getUint16(30, true)] = val1;
        cpu.data[r] = val2;
      }
      cpu.pc = (cpu.pc + 1) % cpu.progMem.length;
      cpu.cycles++;
    }
  }
});

// desktop/apps/desktop/node_modules/avr8js/dist/cjs/peripherals/adc.js
var require_adc = __commonJS({
  "desktop/apps/desktop/node_modules/avr8js/dist/cjs/peripherals/adc.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.AVRADC = exports.adcConfig = exports.atmega328Channels = exports.ADCMuxInputType = exports.ADCReference = void 0;
    var ADCReference2;
    (function(ADCReference3) {
      ADCReference3[ADCReference3["AVCC"] = 0] = "AVCC";
      ADCReference3[ADCReference3["AREF"] = 1] = "AREF";
      ADCReference3[ADCReference3["Internal1V1"] = 2] = "Internal1V1";
      ADCReference3[ADCReference3["Internal2V56"] = 3] = "Internal2V56";
      ADCReference3[ADCReference3["Reserved"] = 4] = "Reserved";
    })(ADCReference2 || (exports.ADCReference = ADCReference2 = {}));
    var ADCMuxInputType2;
    (function(ADCMuxInputType3) {
      ADCMuxInputType3[ADCMuxInputType3["SingleEnded"] = 0] = "SingleEnded";
      ADCMuxInputType3[ADCMuxInputType3["Differential"] = 1] = "Differential";
      ADCMuxInputType3[ADCMuxInputType3["Constant"] = 2] = "Constant";
      ADCMuxInputType3[ADCMuxInputType3["Temperature"] = 3] = "Temperature";
    })(ADCMuxInputType2 || (exports.ADCMuxInputType = ADCMuxInputType2 = {}));
    exports.atmega328Channels = {
      0: { type: ADCMuxInputType2.SingleEnded, channel: 0 },
      1: { type: ADCMuxInputType2.SingleEnded, channel: 1 },
      2: { type: ADCMuxInputType2.SingleEnded, channel: 2 },
      3: { type: ADCMuxInputType2.SingleEnded, channel: 3 },
      4: { type: ADCMuxInputType2.SingleEnded, channel: 4 },
      5: { type: ADCMuxInputType2.SingleEnded, channel: 5 },
      6: { type: ADCMuxInputType2.SingleEnded, channel: 6 },
      7: { type: ADCMuxInputType2.SingleEnded, channel: 7 },
      8: { type: ADCMuxInputType2.Temperature },
      14: { type: ADCMuxInputType2.Constant, voltage: 1.1 },
      15: { type: ADCMuxInputType2.Constant, voltage: 0 }
    };
    var fallbackMuxInput = {
      type: ADCMuxInputType2.Constant,
      voltage: 0
    };
    exports.adcConfig = {
      ADMUX: 124,
      ADCSRA: 122,
      ADCSRB: 123,
      ADCL: 120,
      ADCH: 121,
      DIDR0: 126,
      adcInterrupt: 42,
      numChannels: 8,
      muxInputMask: 15,
      muxChannels: exports.atmega328Channels,
      adcReferences: [
        ADCReference2.AREF,
        ADCReference2.AVCC,
        ADCReference2.Reserved,
        ADCReference2.Internal1V1
      ]
    };
    var ADPS_MASK = 7;
    var ADIE = 8;
    var ADIF = 16;
    var ADSC = 64;
    var ADEN = 128;
    var MUX_MASK = 31;
    var ADLAR = 32;
    var MUX5 = 8;
    var REFS2 = 8;
    var REFS_MASK = 3;
    var REFS_SHIFT = 6;
    var AVRADC2 = class {
      constructor(cpu, config) {
        this.cpu = cpu;
        this.config = config;
        this.channelValues = new Array(this.config.numChannels);
        this.avcc = 5;
        this.aref = 5;
        this.onADCRead = (input) => {
          var _a;
          let voltage = 0;
          switch (input.type) {
            case ADCMuxInputType2.Constant:
              voltage = input.voltage;
              break;
            case ADCMuxInputType2.SingleEnded:
              voltage = (_a = this.channelValues[input.channel]) !== null && _a !== void 0 ? _a : 0;
              break;
            case ADCMuxInputType2.Differential:
              voltage = input.gain * ((this.channelValues[input.positiveChannel] || 0) - (this.channelValues[input.negativeChannel] || 0));
              break;
            case ADCMuxInputType2.Temperature:
              voltage = 0.378125;
              break;
          }
          const rawValue = voltage / this.referenceVoltage * 1024;
          const result = Math.min(Math.max(Math.floor(rawValue), 0), 1023);
          this.cpu.addClockEvent(() => this.completeADCRead(result), this.sampleCycles);
        };
        this.converting = false;
        this.conversionCycles = 25;
        this.ADC = {
          address: this.config.adcInterrupt,
          flagRegister: this.config.ADCSRA,
          flagMask: ADIF,
          enableRegister: this.config.ADCSRA,
          enableMask: ADIE
        };
        cpu.writeHooks[config.ADCSRA] = (value, oldValue) => {
          var _a;
          if (value & ADEN && !(oldValue & ADEN)) {
            this.conversionCycles = 25;
          }
          cpu.data[config.ADCSRA] = value;
          cpu.updateInterruptEnable(this.ADC, value);
          if (!this.converting && value & ADSC) {
            if (!(value & ADEN)) {
              this.cpu.addClockEvent(() => this.completeADCRead(0), this.sampleCycles);
              return true;
            }
            let channel = this.cpu.data[this.config.ADMUX] & MUX_MASK;
            if (cpu.data[config.ADCSRB] & MUX5) {
              channel |= 32;
            }
            channel &= config.muxInputMask;
            const muxInput = (_a = config.muxChannels[channel]) !== null && _a !== void 0 ? _a : fallbackMuxInput;
            this.converting = true;
            this.onADCRead(muxInput);
            return true;
          }
        };
      }
      completeADCRead(value) {
        const { ADCL, ADCH, ADMUX, ADCSRA } = this.config;
        this.converting = false;
        this.conversionCycles = 13;
        if (this.cpu.data[ADMUX] & ADLAR) {
          this.cpu.data[ADCL] = value << 6 & 255;
          this.cpu.data[ADCH] = value >> 2;
        } else {
          this.cpu.data[ADCL] = value & 255;
          this.cpu.data[ADCH] = value >> 8 & 3;
        }
        this.cpu.data[ADCSRA] &= ~ADSC;
        this.cpu.setInterruptFlag(this.ADC);
      }
      get prescaler() {
        const { ADCSRA } = this.config;
        const adcsra = this.cpu.data[ADCSRA];
        const adps = adcsra & ADPS_MASK;
        switch (adps) {
          case 0:
          case 1:
            return 2;
          case 2:
            return 4;
          case 3:
            return 8;
          case 4:
            return 16;
          case 5:
            return 32;
          case 6:
            return 64;
          case 7:
          default:
            return 128;
        }
      }
      get referenceVoltageType() {
        var _a;
        const { ADMUX, adcReferences } = this.config;
        let refs = this.cpu.data[ADMUX] >> REFS_SHIFT & REFS_MASK;
        if (adcReferences.length > 4 && this.cpu.data[ADMUX] & REFS2) {
          refs |= 4;
        }
        return (_a = adcReferences[refs]) !== null && _a !== void 0 ? _a : ADCReference2.Reserved;
      }
      get referenceVoltage() {
        switch (this.referenceVoltageType) {
          case ADCReference2.AVCC:
            return this.avcc;
          case ADCReference2.AREF:
            return this.aref;
          case ADCReference2.Internal1V1:
            return 1.1;
          case ADCReference2.Internal2V56:
            return 2.56;
          default:
            return this.avcc;
        }
      }
      get sampleCycles() {
        return this.conversionCycles * this.prescaler;
      }
    };
    exports.AVRADC = AVRADC2;
  }
});

// desktop/apps/desktop/node_modules/avr8js/dist/cjs/peripherals/clock.js
var require_clock = __commonJS({
  "desktop/apps/desktop/node_modules/avr8js/dist/cjs/peripherals/clock.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.AVRClock = exports.clockConfig = void 0;
    var CLKPCE = 128;
    exports.clockConfig = {
      CLKPR: 97
    };
    var prescalers = [
      1,
      2,
      4,
      8,
      16,
      32,
      64,
      128,
      256,
      // The following values are "reserved" according to the datasheet, so we measured
      // with a scope to figure them out (on ATmega328p)
      2,
      4,
      8,
      16,
      32,
      64,
      128
    ];
    var AVRClock = class {
      constructor(cpu, baseFreqHz, config = exports.clockConfig) {
        this.cpu = cpu;
        this.baseFreqHz = baseFreqHz;
        this.config = config;
        this.clockEnabledCycles = 0;
        this.prescalerValue = 1;
        this.cyclesDelta = 0;
        this.cpu.writeHooks[this.config.CLKPR] = (clkpr) => {
          if ((!this.clockEnabledCycles || this.clockEnabledCycles < cpu.cycles) && clkpr === CLKPCE) {
            this.clockEnabledCycles = this.cpu.cycles + 4;
          } else if (this.clockEnabledCycles && this.clockEnabledCycles >= cpu.cycles) {
            this.clockEnabledCycles = 0;
            const index = clkpr & 15;
            const oldPrescaler = this.prescalerValue;
            this.prescalerValue = prescalers[index];
            this.cpu.data[this.config.CLKPR] = index;
            if (oldPrescaler !== this.prescalerValue) {
              this.cyclesDelta = (cpu.cycles + this.cyclesDelta) * (oldPrescaler / this.prescalerValue) - cpu.cycles;
            }
          }
          return true;
        };
      }
      get frequency() {
        return this.baseFreqHz / this.prescalerValue;
      }
      get prescaler() {
        return this.prescalerValue;
      }
      get timeNanos() {
        return (this.cpu.cycles + this.cyclesDelta) / this.frequency * 1e9;
      }
      get timeMicros() {
        return (this.cpu.cycles + this.cyclesDelta) / this.frequency * 1e6;
      }
      get timeMillis() {
        return (this.cpu.cycles + this.cyclesDelta) / this.frequency * 1e3;
      }
    };
    exports.AVRClock = AVRClock;
  }
});

// desktop/apps/desktop/node_modules/avr8js/dist/cjs/peripherals/eeprom.js
var require_eeprom = __commonJS({
  "desktop/apps/desktop/node_modules/avr8js/dist/cjs/peripherals/eeprom.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.AVREEPROM = exports.eepromConfig = exports.EEPROMMemoryBackend = void 0;
    var EEPROMMemoryBackend = class {
      constructor(size) {
        this.memory = new Uint8Array(size);
        this.memory.fill(255);
      }
      readMemory(addr) {
        return this.memory[addr];
      }
      writeMemory(addr, value) {
        this.memory[addr] &= value;
      }
      eraseMemory(addr) {
        this.memory[addr] = 255;
      }
    };
    exports.EEPROMMemoryBackend = EEPROMMemoryBackend;
    exports.eepromConfig = {
      eepromReadyInterrupt: 44,
      EECR: 63,
      EEDR: 64,
      EEARL: 65,
      EEARH: 66,
      eraseCycles: 28800,
      // 1.8ms at 16MHz
      writeCycles: 28800
      // 1.8ms at 16MHz
    };
    var EERE = 1 << 0;
    var EEPE = 1 << 1;
    var EEMPE = 1 << 2;
    var EERIE = 1 << 3;
    var EEPM0 = 1 << 4;
    var EEPM1 = 1 << 5;
    var EECR_WRITE_MASK = EEPE | EEMPE | EERIE | EEPM0 | EEPM1;
    var AVREEPROM = class {
      constructor(cpu, backend, config = exports.eepromConfig) {
        this.cpu = cpu;
        this.backend = backend;
        this.config = config;
        this.writeEnabledCycles = 0;
        this.writeCompleteCycles = 0;
        this.EER = {
          address: this.config.eepromReadyInterrupt,
          flagRegister: this.config.EECR,
          flagMask: EEPE,
          enableRegister: this.config.EECR,
          enableMask: EERIE,
          constant: true,
          inverseFlag: true
        };
        this.cpu.writeHooks[this.config.EECR] = (eecr) => {
          const { EEARH, EEARL, EECR, EEDR } = this.config;
          const addr = this.cpu.data[EEARH] << 8 | this.cpu.data[EEARL];
          this.cpu.data[EECR] = this.cpu.data[EECR] & ~EECR_WRITE_MASK | eecr & EECR_WRITE_MASK;
          this.cpu.updateInterruptEnable(this.EER, eecr);
          if (eecr & EERE) {
            this.cpu.clearInterrupt(this.EER);
          }
          if (eecr & EEMPE) {
            const eempeCycles = 4;
            this.writeEnabledCycles = this.cpu.cycles + eempeCycles;
            this.cpu.addClockEvent(() => {
              this.cpu.data[EECR] &= ~EEMPE;
            }, eempeCycles);
          }
          if (eecr & EERE) {
            this.cpu.data[EEDR] = this.backend.readMemory(addr);
            this.cpu.cycles += 4;
            return true;
          }
          if (eecr & EEPE) {
            if (this.cpu.cycles >= this.writeEnabledCycles) {
              this.cpu.data[EECR] &= ~EEPE;
              return true;
            }
            if (this.cpu.cycles < this.writeCompleteCycles) {
              return true;
            }
            const eedr = this.cpu.data[EEDR];
            this.writeCompleteCycles = this.cpu.cycles;
            if (!(eecr & EEPM1)) {
              this.backend.eraseMemory(addr);
              this.writeCompleteCycles += this.config.eraseCycles;
            }
            if (!(eecr & EEPM0)) {
              this.backend.writeMemory(addr, eedr);
              this.writeCompleteCycles += this.config.writeCycles;
            }
            this.cpu.data[EECR] |= EEPE;
            this.cpu.addClockEvent(() => {
              this.cpu.setInterruptFlag(this.EER);
            }, this.writeCompleteCycles - this.cpu.cycles);
            this.cpu.cycles += 2;
          }
          return true;
        };
      }
    };
    exports.AVREEPROM = AVREEPROM;
  }
});

// desktop/apps/desktop/node_modules/avr8js/dist/cjs/peripherals/gpio.js
var require_gpio = __commonJS({
  "desktop/apps/desktop/node_modules/avr8js/dist/cjs/peripherals/gpio.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.AVRIOPort = exports.PinOverrideMode = exports.PinState = exports.portLConfig = exports.portKConfig = exports.portJConfig = exports.portHConfig = exports.portGConfig = exports.portFConfig = exports.portEConfig = exports.portDConfig = exports.portCConfig = exports.portBConfig = exports.portAConfig = exports.PCINT2 = exports.PCINT1 = exports.PCINT0 = exports.INT1 = exports.INT0 = void 0;
    exports.INT0 = {
      EICR: 105,
      EIMSK: 61,
      EIFR: 60,
      index: 0,
      iscOffset: 0,
      interrupt: 2
    };
    exports.INT1 = {
      EICR: 105,
      EIMSK: 61,
      EIFR: 60,
      index: 1,
      iscOffset: 2,
      interrupt: 4
    };
    exports.PCINT0 = {
      PCIE: 0,
      PCICR: 104,
      PCIFR: 59,
      PCMSK: 107,
      pinChangeInterrupt: 6,
      mask: 255,
      offset: 0
    };
    exports.PCINT1 = {
      PCIE: 1,
      PCICR: 104,
      PCIFR: 59,
      PCMSK: 108,
      pinChangeInterrupt: 8,
      mask: 255,
      offset: 0
    };
    exports.PCINT2 = {
      PCIE: 2,
      PCICR: 104,
      PCIFR: 59,
      PCMSK: 109,
      pinChangeInterrupt: 10,
      mask: 255,
      offset: 0
    };
    exports.portAConfig = {
      PIN: 32,
      DDR: 33,
      PORT: 34,
      externalInterrupts: []
    };
    exports.portBConfig = {
      PIN: 35,
      DDR: 36,
      PORT: 37,
      // Interrupt settings
      pinChange: exports.PCINT0,
      externalInterrupts: []
    };
    exports.portCConfig = {
      PIN: 38,
      DDR: 39,
      PORT: 40,
      // Interrupt settings
      pinChange: exports.PCINT1,
      externalInterrupts: []
    };
    exports.portDConfig = {
      PIN: 41,
      DDR: 42,
      PORT: 43,
      // Interrupt settings
      pinChange: exports.PCINT2,
      externalInterrupts: [null, null, exports.INT0, exports.INT1]
    };
    exports.portEConfig = {
      PIN: 44,
      DDR: 45,
      PORT: 46,
      externalInterrupts: []
    };
    exports.portFConfig = {
      PIN: 47,
      DDR: 48,
      PORT: 49,
      externalInterrupts: []
    };
    exports.portGConfig = {
      PIN: 50,
      DDR: 51,
      PORT: 52,
      externalInterrupts: []
    };
    exports.portHConfig = {
      PIN: 256,
      DDR: 257,
      PORT: 258,
      externalInterrupts: []
    };
    exports.portJConfig = {
      PIN: 259,
      DDR: 260,
      PORT: 261,
      externalInterrupts: []
    };
    exports.portKConfig = {
      PIN: 262,
      DDR: 263,
      PORT: 264,
      externalInterrupts: []
    };
    exports.portLConfig = {
      PIN: 265,
      DDR: 266,
      PORT: 267,
      externalInterrupts: []
    };
    var PinState2;
    (function(PinState3) {
      PinState3[PinState3["Low"] = 0] = "Low";
      PinState3[PinState3["High"] = 1] = "High";
      PinState3[PinState3["Input"] = 2] = "Input";
      PinState3[PinState3["InputPullUp"] = 3] = "InputPullUp";
    })(PinState2 || (exports.PinState = PinState2 = {}));
    var PinOverrideMode;
    (function(PinOverrideMode2) {
      PinOverrideMode2[PinOverrideMode2["None"] = 0] = "None";
      PinOverrideMode2[PinOverrideMode2["Enable"] = 1] = "Enable";
      PinOverrideMode2[PinOverrideMode2["Set"] = 2] = "Set";
      PinOverrideMode2[PinOverrideMode2["Clear"] = 3] = "Clear";
      PinOverrideMode2[PinOverrideMode2["Toggle"] = 4] = "Toggle";
    })(PinOverrideMode || (exports.PinOverrideMode = PinOverrideMode = {}));
    var InterruptMode;
    (function(InterruptMode2) {
      InterruptMode2[InterruptMode2["LowLevel"] = 0] = "LowLevel";
      InterruptMode2[InterruptMode2["Change"] = 1] = "Change";
      InterruptMode2[InterruptMode2["FallingEdge"] = 2] = "FallingEdge";
      InterruptMode2[InterruptMode2["RisingEdge"] = 3] = "RisingEdge";
    })(InterruptMode || (InterruptMode = {}));
    var AVRIOPort2 = class {
      constructor(cpu, portConfig) {
        var _a, _b, _c, _d;
        this.cpu = cpu;
        this.portConfig = portConfig;
        this.externalClockListeners = [];
        this.listeners = [];
        this.pinValue = 0;
        this.overrideMask = 255;
        this.overrideValue = 0;
        this.lastValue = 0;
        this.lastDdr = 0;
        this.lastPin = 0;
        this.openCollector = 0;
        cpu.gpioPorts.add(this);
        cpu.gpioByPort[portConfig.PORT] = this;
        cpu.writeHooks[portConfig.DDR] = (value) => {
          const portValue = cpu.data[portConfig.PORT];
          cpu.data[portConfig.DDR] = value;
          this.writeGpio(portValue, value);
          this.updatePinRegister(value);
          return true;
        };
        cpu.writeHooks[portConfig.PORT] = (value) => {
          const ddrMask = cpu.data[portConfig.DDR];
          cpu.data[portConfig.PORT] = value;
          this.writeGpio(value, ddrMask);
          this.updatePinRegister(ddrMask);
          return true;
        };
        cpu.writeHooks[portConfig.PIN] = (value, oldValue, addr, mask) => {
          const oldPortValue = cpu.data[portConfig.PORT];
          const ddrMask = cpu.data[portConfig.DDR];
          const portValue = oldPortValue ^ value & mask;
          cpu.data[portConfig.PORT] = portValue;
          this.writeGpio(portValue, ddrMask);
          this.updatePinRegister(ddrMask);
          return true;
        };
        const { externalInterrupts } = portConfig;
        this.externalInts = externalInterrupts.map((externalConfig) => externalConfig ? {
          address: externalConfig.interrupt,
          flagRegister: externalConfig.EIFR,
          flagMask: 1 << externalConfig.index,
          enableRegister: externalConfig.EIMSK,
          enableMask: 1 << externalConfig.index
        } : null);
        const EICR = new Set(externalInterrupts.map((item) => item === null || item === void 0 ? void 0 : item.EICR));
        for (const EICRx of EICR) {
          this.attachInterruptHook(EICRx || 0);
        }
        const EIMSK = (_b = (_a = externalInterrupts.find((item) => item && item.EIMSK)) === null || _a === void 0 ? void 0 : _a.EIMSK) !== null && _b !== void 0 ? _b : 0;
        this.attachInterruptHook(EIMSK, "mask");
        const EIFR = (_d = (_c = externalInterrupts.find((item) => item && item.EIFR)) === null || _c === void 0 ? void 0 : _c.EIFR) !== null && _d !== void 0 ? _d : 0;
        this.attachInterruptHook(EIFR, "flag");
        const { pinChange } = portConfig;
        this.PCINT = pinChange ? {
          address: pinChange.pinChangeInterrupt,
          flagRegister: pinChange.PCIFR,
          flagMask: 1 << pinChange.PCIE,
          enableRegister: pinChange.PCICR,
          enableMask: 1 << pinChange.PCIE
        } : null;
        if (pinChange) {
          const { PCIFR, PCMSK } = pinChange;
          cpu.writeHooks[PCIFR] = (value) => {
            for (const gpio of this.cpu.gpioPorts) {
              const { PCINT } = gpio;
              if (PCINT) {
                cpu.clearInterruptByFlag(PCINT, value);
              }
            }
            return true;
          };
          cpu.writeHooks[PCMSK] = (value) => {
            cpu.data[PCMSK] = value;
            for (const gpio of this.cpu.gpioPorts) {
              const { PCINT } = gpio;
              if (PCINT) {
                cpu.updateInterruptEnable(PCINT, value);
              }
            }
            return true;
          };
        }
      }
      addListener(listener) {
        this.listeners.push(listener);
      }
      removeListener(listener) {
        this.listeners = this.listeners.filter((l) => l !== listener);
      }
      /**
       * Get the state of a given GPIO pin
       *
       * @param index Pin index to return from 0 to 7
       * @returns PinState.Low or PinState.High if the pin is set to output, PinState.Input if the pin is set
       *   to input, and PinState.InputPullUp if the pin is set to input and the internal pull-up resistor has
       *   been enabled.
       */
      pinState(index) {
        const ddr = this.cpu.data[this.portConfig.DDR];
        const port = this.cpu.data[this.portConfig.PORT];
        const bitMask = 1 << index;
        const openState = port & bitMask ? PinState2.InputPullUp : PinState2.Input;
        const highValue = this.openCollector & bitMask ? openState : PinState2.High;
        if (ddr & bitMask) {
          return this.lastValue & bitMask ? highValue : PinState2.Low;
        } else {
          return openState;
        }
      }
      /**
       * Sets the input value for the given pin. This is the value that
       * will be returned when reading from the PIN register.
       */
      setPin(index, value) {
        const bitMask = 1 << index;
        this.pinValue &= ~bitMask;
        if (value) {
          this.pinValue |= bitMask;
        }
        this.updatePinRegister(this.cpu.data[this.portConfig.DDR]);
      }
      /**
       * Internal method - do not call this directly!
       * Used by the timer compare output units to override GPIO pins.
       */
      timerOverridePin(pin, mode) {
        const { cpu, portConfig } = this;
        const pinMask = 1 << pin;
        if (mode === PinOverrideMode.None) {
          this.overrideMask |= pinMask;
          this.overrideValue &= ~pinMask;
        } else {
          this.overrideMask &= ~pinMask;
          switch (mode) {
            case PinOverrideMode.Enable:
              this.overrideValue &= ~pinMask;
              this.overrideValue |= cpu.data[portConfig.PORT] & pinMask;
              break;
            case PinOverrideMode.Set:
              this.overrideValue |= pinMask;
              break;
            case PinOverrideMode.Clear:
              this.overrideValue &= ~pinMask;
              break;
            case PinOverrideMode.Toggle:
              this.overrideValue ^= pinMask;
              break;
          }
        }
        const ddrMask = cpu.data[portConfig.DDR];
        this.writeGpio(cpu.data[portConfig.PORT], ddrMask);
        this.updatePinRegister(ddrMask);
      }
      updatePinRegister(ddr) {
        var _a, _b;
        const newPin = this.pinValue & ~ddr | this.lastValue & ddr;
        this.cpu.data[this.portConfig.PIN] = newPin;
        if (this.lastPin !== newPin) {
          for (let index = 0; index < 8; index++) {
            if ((newPin & 1 << index) !== (this.lastPin & 1 << index)) {
              const value = !!(newPin & 1 << index);
              this.toggleInterrupt(index, value);
              (_b = (_a = this.externalClockListeners)[index]) === null || _b === void 0 ? void 0 : _b.call(_a, value);
            }
          }
          this.lastPin = newPin;
        }
      }
      toggleInterrupt(pin, risingEdge) {
        const { cpu, portConfig, externalInts, PCINT } = this;
        const { externalInterrupts, pinChange } = portConfig;
        const externalConfig = externalInterrupts[pin];
        const external = externalInts[pin];
        if (external && externalConfig) {
          const { EIMSK, index, EICR, iscOffset } = externalConfig;
          if (cpu.data[EIMSK] & 1 << index) {
            const configuration = cpu.data[EICR] >> iscOffset & 3;
            let generateInterrupt = false;
            external.constant = false;
            switch (configuration) {
              case InterruptMode.LowLevel:
                generateInterrupt = !risingEdge;
                external.constant = true;
                break;
              case InterruptMode.Change:
                generateInterrupt = true;
                break;
              case InterruptMode.FallingEdge:
                generateInterrupt = !risingEdge;
                break;
              case InterruptMode.RisingEdge:
                generateInterrupt = risingEdge;
                break;
            }
            if (generateInterrupt) {
              cpu.setInterruptFlag(external);
            } else if (external.constant) {
              cpu.clearInterrupt(external, true);
            }
          }
        }
        if (pinChange && PCINT && pinChange.mask & 1 << pin) {
          const { PCMSK } = pinChange;
          if (cpu.data[PCMSK] & 1 << pin + pinChange.offset) {
            cpu.setInterruptFlag(PCINT);
          }
        }
      }
      attachInterruptHook(register, registerType = "other") {
        if (!register) {
          return;
        }
        const { cpu } = this;
        cpu.writeHooks[register] = (value) => {
          if (registerType !== "flag") {
            cpu.data[register] = value;
          }
          for (const gpio of cpu.gpioPorts) {
            for (const external of gpio.externalInts) {
              if (external && registerType === "mask") {
                cpu.updateInterruptEnable(external, value);
              }
              if (external && !external.constant && registerType === "flag") {
                cpu.clearInterruptByFlag(external, value);
              }
            }
            gpio.checkExternalInterrupts();
          }
          return true;
        };
      }
      checkExternalInterrupts() {
        const { cpu } = this;
        const { externalInterrupts } = this.portConfig;
        for (let pin = 0; pin < 8; pin++) {
          const external = externalInterrupts[pin];
          if (!external) {
            continue;
          }
          const pinValue = !!(this.lastPin & 1 << pin);
          const { EIFR, EIMSK, index, EICR, iscOffset, interrupt } = external;
          if (!(cpu.data[EIMSK] & 1 << index) || pinValue) {
            continue;
          }
          const configuration = cpu.data[EICR] >> iscOffset & 3;
          if (configuration === InterruptMode.LowLevel) {
            cpu.queueInterrupt({
              address: interrupt,
              flagRegister: EIFR,
              flagMask: 1 << index,
              enableRegister: EIMSK,
              enableMask: 1 << index,
              constant: true
            });
          }
        }
      }
      writeGpio(value, ddr) {
        const newValue = (value & this.overrideMask | this.overrideValue) & ddr | value & ~ddr;
        const prevValue = this.lastValue;
        if (newValue !== prevValue || ddr !== this.lastDdr) {
          this.lastValue = newValue;
          this.lastDdr = ddr;
          for (const listener of this.listeners) {
            listener(newValue, prevValue);
          }
        }
      }
    };
    exports.AVRIOPort = AVRIOPort2;
  }
});

// desktop/apps/desktop/node_modules/avr8js/dist/cjs/peripherals/spi.js
var require_spi = __commonJS({
  "desktop/apps/desktop/node_modules/avr8js/dist/cjs/peripherals/spi.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.AVRSPI = exports.spiConfig = void 0;
    var SPCR_SPIE = 128;
    var SPCR_SPE = 64;
    var SPCR_DORD = 32;
    var SPCR_MSTR = 16;
    var SPCR_CPOL = 8;
    var SPCR_CPHA = 4;
    var SPCR_SPR1 = 2;
    var SPCR_SPR0 = 1;
    var SPSR_SPR_MASK = SPCR_SPR1 | SPCR_SPR0;
    var SPSR_SPIF = 128;
    var SPSR_WCOL = 64;
    var SPSR_SPI2X = 1;
    exports.spiConfig = {
      spiInterrupt: 34,
      SPCR: 76,
      SPSR: 77,
      SPDR: 78
    };
    var bitsPerByte = 8;
    var AVRSPI = class {
      constructor(cpu, config, freqHz) {
        this.cpu = cpu;
        this.config = config;
        this.freqHz = freqHz;
        this.onTransfer = () => 0;
        this.onByte = (value) => {
          const valueIn = this.onTransfer(value);
          this.cpu.addClockEvent(() => this.completeTransfer(valueIn), this.transferCycles);
        };
        this.transmissionActive = false;
        this.SPI = {
          address: this.config.spiInterrupt,
          flagRegister: this.config.SPSR,
          flagMask: SPSR_SPIF,
          enableRegister: this.config.SPCR,
          enableMask: SPCR_SPIE
        };
        const { SPCR, SPSR, SPDR } = config;
        cpu.writeHooks[SPDR] = (value) => {
          if (!(cpu.data[SPCR] & SPCR_SPE)) {
            return;
          }
          if (this.transmissionActive) {
            cpu.data[SPSR] |= SPSR_WCOL;
            return true;
          }
          cpu.data[SPSR] &= ~SPSR_WCOL;
          this.cpu.clearInterrupt(this.SPI);
          this.transmissionActive = true;
          this.onByte(value);
          return true;
        };
        cpu.writeHooks[SPCR] = (value) => {
          this.cpu.updateInterruptEnable(this.SPI, value);
        };
        cpu.writeHooks[SPSR] = (value) => {
          this.cpu.data[SPSR] = value;
          this.cpu.clearInterruptByFlag(this.SPI, value);
        };
      }
      reset() {
        this.transmissionActive = false;
      }
      /**
       * Completes an SPI transaction. Call this method only from the `onByte` callback.
       *
       * @param receivedByte Byte read from the SPI MISO line.
       */
      completeTransfer(receivedByte) {
        const { SPDR } = this.config;
        this.cpu.data[SPDR] = receivedByte;
        this.cpu.setInterruptFlag(this.SPI);
        this.transmissionActive = false;
      }
      get isMaster() {
        return this.cpu.data[this.config.SPCR] & SPCR_MSTR ? true : false;
      }
      get dataOrder() {
        return this.cpu.data[this.config.SPCR] & SPCR_DORD ? "lsbFirst" : "msbFirst";
      }
      get spiMode() {
        const CPHA = this.cpu.data[this.config.SPCR] & SPCR_CPHA;
        const CPOL = this.cpu.data[this.config.SPCR] & SPCR_CPOL;
        return (CPHA ? 2 : 0) | (CPOL ? 1 : 0);
      }
      /**
       * The clock divider is only relevant for Master mode
       */
      get clockDivider() {
        const base = this.cpu.data[this.config.SPSR] & SPSR_SPI2X ? 2 : 4;
        switch (this.cpu.data[this.config.SPCR] & SPSR_SPR_MASK) {
          case 0:
            return base;
          case 1:
            return base * 4;
          case 2:
            return base * 16;
          case 3:
            return base * 32;
        }
        throw new Error("Invalid divider value!");
      }
      /** Number of cycles to complete a single byte SPI transaction */
      get transferCycles() {
        return this.clockDivider * bitsPerByte;
      }
      /**
       * The SPI freqeuncy is only relevant to Master mode.
       * In slave mode, the frequency can be as high as F(osc) / 4.
       */
      get spiFrequency() {
        return this.freqHz / this.clockDivider;
      }
    };
    exports.AVRSPI = AVRSPI;
  }
});

// desktop/apps/desktop/node_modules/avr8js/dist/cjs/peripherals/timer.js
var require_timer = __commonJS({
  "desktop/apps/desktop/node_modules/avr8js/dist/cjs/peripherals/timer.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.AVRTimer = exports.timer2Config = exports.timer1Config = exports.timer0Config = void 0;
    var gpio_1 = require_gpio();
    var timer01Dividers = {
      0: 0,
      1: 1,
      2: 8,
      3: 64,
      4: 256,
      5: 1024,
      6: 0,
      // External clock - see ExternalClockMode
      7: 0
      // Ditto
    };
    var ExternalClockMode;
    (function(ExternalClockMode2) {
      ExternalClockMode2[ExternalClockMode2["FallingEdge"] = 6] = "FallingEdge";
      ExternalClockMode2[ExternalClockMode2["RisingEdge"] = 7] = "RisingEdge";
    })(ExternalClockMode || (ExternalClockMode = {}));
    var defaultTimerBits = {
      // TIFR bits
      TOV: 1,
      OCFA: 2,
      OCFB: 4,
      OCFC: 0,
      // Unused
      // TIMSK bits
      TOIE: 1,
      OCIEA: 2,
      OCIEB: 4,
      OCIEC: 0
      // Unused
    };
    exports.timer0Config = Object.assign({ bits: 8, captureInterrupt: 0, compAInterrupt: 28, compBInterrupt: 30, compCInterrupt: 0, ovfInterrupt: 32, TIFR: 53, OCRA: 71, OCRB: 72, OCRC: 0, ICR: 0, TCNT: 70, TCCRA: 68, TCCRB: 69, TCCRC: 0, TIMSK: 110, dividers: timer01Dividers, compPortA: gpio_1.portDConfig.PORT, compPinA: 6, compPortB: gpio_1.portDConfig.PORT, compPinB: 5, compPortC: 0, compPinC: 0, externalClockPort: gpio_1.portDConfig.PORT, externalClockPin: 4 }, defaultTimerBits);
    exports.timer1Config = Object.assign({ bits: 16, captureInterrupt: 20, compAInterrupt: 22, compBInterrupt: 24, compCInterrupt: 0, ovfInterrupt: 26, TIFR: 54, OCRA: 136, OCRB: 138, OCRC: 0, ICR: 134, TCNT: 132, TCCRA: 128, TCCRB: 129, TCCRC: 130, TIMSK: 111, dividers: timer01Dividers, compPortA: gpio_1.portBConfig.PORT, compPinA: 1, compPortB: gpio_1.portBConfig.PORT, compPinB: 2, compPortC: 0, compPinC: 0, externalClockPort: gpio_1.portDConfig.PORT, externalClockPin: 5 }, defaultTimerBits);
    exports.timer2Config = Object.assign({ bits: 8, captureInterrupt: 0, compAInterrupt: 14, compBInterrupt: 16, compCInterrupt: 0, ovfInterrupt: 18, TIFR: 55, OCRA: 179, OCRB: 180, OCRC: 0, ICR: 0, TCNT: 178, TCCRA: 176, TCCRB: 177, TCCRC: 0, TIMSK: 112, dividers: {
      0: 0,
      1: 1,
      2: 8,
      3: 32,
      4: 64,
      5: 128,
      6: 256,
      7: 1024
    }, compPortA: gpio_1.portBConfig.PORT, compPinA: 3, compPortB: gpio_1.portDConfig.PORT, compPinB: 3, compPortC: 0, compPinC: 0, externalClockPort: 0, externalClockPin: 0 }, defaultTimerBits);
    var TimerMode;
    (function(TimerMode2) {
      TimerMode2[TimerMode2["Normal"] = 0] = "Normal";
      TimerMode2[TimerMode2["PWMPhaseCorrect"] = 1] = "PWMPhaseCorrect";
      TimerMode2[TimerMode2["CTC"] = 2] = "CTC";
      TimerMode2[TimerMode2["FastPWM"] = 3] = "FastPWM";
      TimerMode2[TimerMode2["PWMPhaseFrequencyCorrect"] = 4] = "PWMPhaseFrequencyCorrect";
      TimerMode2[TimerMode2["Reserved"] = 5] = "Reserved";
    })(TimerMode || (TimerMode = {}));
    var TOVUpdateMode;
    (function(TOVUpdateMode2) {
      TOVUpdateMode2[TOVUpdateMode2["Max"] = 0] = "Max";
      TOVUpdateMode2[TOVUpdateMode2["Top"] = 1] = "Top";
      TOVUpdateMode2[TOVUpdateMode2["Bottom"] = 2] = "Bottom";
    })(TOVUpdateMode || (TOVUpdateMode = {}));
    var OCRUpdateMode;
    (function(OCRUpdateMode2) {
      OCRUpdateMode2[OCRUpdateMode2["Immediate"] = 0] = "Immediate";
      OCRUpdateMode2[OCRUpdateMode2["Top"] = 1] = "Top";
      OCRUpdateMode2[OCRUpdateMode2["Bottom"] = 2] = "Bottom";
    })(OCRUpdateMode || (OCRUpdateMode = {}));
    var TopOCRA = 1;
    var TopICR = 2;
    var OCToggle = 1;
    var { Normal, PWMPhaseCorrect, CTC, FastPWM, Reserved, PWMPhaseFrequencyCorrect } = TimerMode;
    var wgmModes8Bit = [
      /*0*/
      [Normal, 255, OCRUpdateMode.Immediate, TOVUpdateMode.Max, 0],
      /*1*/
      [PWMPhaseCorrect, 255, OCRUpdateMode.Top, TOVUpdateMode.Bottom, 0],
      /*2*/
      [CTC, TopOCRA, OCRUpdateMode.Immediate, TOVUpdateMode.Max, 0],
      /*3*/
      [FastPWM, 255, OCRUpdateMode.Bottom, TOVUpdateMode.Max, 0],
      /*4*/
      [Reserved, 255, OCRUpdateMode.Immediate, TOVUpdateMode.Max, 0],
      /*5*/
      [PWMPhaseCorrect, TopOCRA, OCRUpdateMode.Top, TOVUpdateMode.Bottom, OCToggle],
      /*6*/
      [Reserved, 255, OCRUpdateMode.Immediate, TOVUpdateMode.Max, 0],
      /*7*/
      [FastPWM, TopOCRA, OCRUpdateMode.Bottom, TOVUpdateMode.Top, OCToggle]
    ];
    var wgmModes16Bit = [
      /*0 */
      [Normal, 65535, OCRUpdateMode.Immediate, TOVUpdateMode.Max, 0],
      /*1 */
      [PWMPhaseCorrect, 255, OCRUpdateMode.Top, TOVUpdateMode.Bottom, 0],
      /*2 */
      [PWMPhaseCorrect, 511, OCRUpdateMode.Top, TOVUpdateMode.Bottom, 0],
      /*3 */
      [PWMPhaseCorrect, 1023, OCRUpdateMode.Top, TOVUpdateMode.Bottom, 0],
      /*4 */
      [CTC, TopOCRA, OCRUpdateMode.Immediate, TOVUpdateMode.Max, 0],
      /*5 */
      [FastPWM, 255, OCRUpdateMode.Bottom, TOVUpdateMode.Top, 0],
      /*6 */
      [FastPWM, 511, OCRUpdateMode.Bottom, TOVUpdateMode.Top, 0],
      /*7 */
      [FastPWM, 1023, OCRUpdateMode.Bottom, TOVUpdateMode.Top, 0],
      /*8 */
      [PWMPhaseFrequencyCorrect, TopICR, OCRUpdateMode.Bottom, TOVUpdateMode.Bottom, 0],
      /*9 */
      [PWMPhaseFrequencyCorrect, TopOCRA, OCRUpdateMode.Bottom, TOVUpdateMode.Bottom, OCToggle],
      /*10*/
      [PWMPhaseCorrect, TopICR, OCRUpdateMode.Top, TOVUpdateMode.Bottom, 0],
      /*11*/
      [PWMPhaseCorrect, TopOCRA, OCRUpdateMode.Top, TOVUpdateMode.Bottom, OCToggle],
      /*12*/
      [CTC, TopICR, OCRUpdateMode.Immediate, TOVUpdateMode.Max, 0],
      /*13*/
      [Reserved, 65535, OCRUpdateMode.Immediate, TOVUpdateMode.Max, 0],
      /*14*/
      [FastPWM, TopICR, OCRUpdateMode.Bottom, TOVUpdateMode.Top, OCToggle],
      /*15*/
      [FastPWM, TopOCRA, OCRUpdateMode.Bottom, TOVUpdateMode.Top, OCToggle]
    ];
    function compToOverride(comp) {
      switch (comp) {
        case 1:
          return gpio_1.PinOverrideMode.Toggle;
        case 2:
          return gpio_1.PinOverrideMode.Clear;
        case 3:
          return gpio_1.PinOverrideMode.Set;
        default:
          return gpio_1.PinOverrideMode.Enable;
      }
    }
    var FOCA = 1 << 7;
    var FOCB = 1 << 6;
    var FOCC = 1 << 5;
    var AVRTimer2 = class {
      constructor(cpu, config) {
        this.cpu = cpu;
        this.config = config;
        this.MAX = this.config.bits === 16 ? 65535 : 255;
        this.lastCycle = 0;
        this.ocrA = 0;
        this.nextOcrA = 0;
        this.ocrB = 0;
        this.nextOcrB = 0;
        this.hasOCRC = this.config.OCRC > 0;
        this.ocrC = 0;
        this.nextOcrC = 0;
        this.ocrUpdateMode = OCRUpdateMode.Immediate;
        this.tovUpdateMode = TOVUpdateMode.Max;
        this.icr = 0;
        this.tcnt = 0;
        this.tcntNext = 0;
        this.tcntUpdated = false;
        this.updateDivider = false;
        this.countingUp = true;
        this.divider = 0;
        this.externalClockRisingEdge = false;
        this.highByteTemp = 0;
        this.OVF = {
          address: this.config.ovfInterrupt,
          flagRegister: this.config.TIFR,
          flagMask: this.config.TOV,
          enableRegister: this.config.TIMSK,
          enableMask: this.config.TOIE
        };
        this.OCFA = {
          address: this.config.compAInterrupt,
          flagRegister: this.config.TIFR,
          flagMask: this.config.OCFA,
          enableRegister: this.config.TIMSK,
          enableMask: this.config.OCIEA
        };
        this.OCFB = {
          address: this.config.compBInterrupt,
          flagRegister: this.config.TIFR,
          flagMask: this.config.OCFB,
          enableRegister: this.config.TIMSK,
          enableMask: this.config.OCIEB
        };
        this.OCFC = {
          address: this.config.compCInterrupt,
          flagRegister: this.config.TIFR,
          flagMask: this.config.OCFC,
          enableRegister: this.config.TIMSK,
          enableMask: this.config.OCIEC
        };
        this.count = (reschedule = true, external = false) => {
          const { divider, lastCycle, cpu: cpu2 } = this;
          const { cycles } = cpu2;
          const delta = cycles - lastCycle;
          if (divider && delta >= divider || external) {
            const counterDelta = external ? 1 : Math.floor(delta / divider);
            this.lastCycle += counterDelta * divider;
            const val = this.tcnt;
            const { timerMode, TOP } = this;
            const phasePwm = timerMode === PWMPhaseCorrect || timerMode === PWMPhaseFrequencyCorrect;
            const newVal = phasePwm ? this.phasePwmCount(val, counterDelta) : (val + counterDelta) % (TOP + 1);
            const overflow = val + counterDelta > TOP;
            if (!this.tcntUpdated) {
              this.tcnt = newVal;
              if (!phasePwm) {
                this.timerUpdated(newVal, val);
              }
            }
            if (!phasePwm) {
              if (timerMode === FastPWM && overflow) {
                const { compA, compB } = this;
                if (compA) {
                  this.updateCompPin(compA, "A", true);
                }
                if (compB) {
                  this.updateCompPin(compB, "B", true);
                }
              }
              if (this.ocrUpdateMode == OCRUpdateMode.Bottom && overflow) {
                this.ocrA = this.nextOcrA;
                this.ocrB = this.nextOcrB;
                this.ocrC = this.nextOcrC;
              }
              if (overflow && (this.tovUpdateMode == TOVUpdateMode.Top || TOP === this.MAX)) {
                cpu2.setInterruptFlag(this.OVF);
              }
            }
          }
          if (this.tcntUpdated) {
            this.tcnt = this.tcntNext;
            this.tcntUpdated = false;
            if (this.tcnt === 0 && this.ocrUpdateMode === OCRUpdateMode.Bottom || this.tcnt === this.TOP && this.ocrUpdateMode === OCRUpdateMode.Top) {
              this.ocrA = this.nextOcrA;
              this.ocrB = this.nextOcrB;
              this.ocrC = this.nextOcrC;
            }
          }
          if (this.updateDivider) {
            const { CS } = this;
            const { externalClockPin } = this.config;
            const newDivider = this.config.dividers[CS];
            this.lastCycle = newDivider ? this.cpu.cycles : 0;
            this.updateDivider = false;
            this.divider = newDivider;
            if (this.config.externalClockPort && !this.externalClockPort) {
              this.externalClockPort = this.cpu.gpioByPort[this.config.externalClockPort];
            }
            if (this.externalClockPort) {
              this.externalClockPort.externalClockListeners[externalClockPin] = null;
            }
            if (newDivider) {
              cpu2.addClockEvent(this.count, this.lastCycle + newDivider - cpu2.cycles);
            } else if (this.externalClockPort && (CS === ExternalClockMode.FallingEdge || CS === ExternalClockMode.RisingEdge)) {
              this.externalClockPort.externalClockListeners[externalClockPin] = this.externalClockCallback;
              this.externalClockRisingEdge = CS === ExternalClockMode.RisingEdge;
            }
            return;
          }
          if (reschedule && divider) {
            cpu2.addClockEvent(this.count, this.lastCycle + divider - cpu2.cycles);
          }
        };
        this.externalClockCallback = (value) => {
          if (value === this.externalClockRisingEdge) {
            this.count(false, true);
          }
        };
        this.updateWGMConfig();
        this.cpu.readHooks[config.TCNT] = (addr) => {
          this.count(false);
          if (this.config.bits === 16) {
            this.cpu.data[addr + 1] = this.tcnt >> 8;
          }
          return this.cpu.data[addr] = this.tcnt & 255;
        };
        this.cpu.writeHooks[config.TCNT] = (value) => {
          this.tcntNext = this.highByteTemp << 8 | value;
          this.countingUp = true;
          this.tcntUpdated = true;
          this.cpu.updateClockEvent(this.count, 0);
          if (this.divider) {
            this.timerUpdated(this.tcntNext, this.tcntNext);
          }
        };
        this.cpu.writeHooks[config.OCRA] = (value) => {
          this.nextOcrA = this.highByteTemp << 8 | value;
          if (this.ocrUpdateMode === OCRUpdateMode.Immediate) {
            this.ocrA = this.nextOcrA;
          }
        };
        this.cpu.writeHooks[config.OCRB] = (value) => {
          this.nextOcrB = this.highByteTemp << 8 | value;
          if (this.ocrUpdateMode === OCRUpdateMode.Immediate) {
            this.ocrB = this.nextOcrB;
          }
        };
        if (this.hasOCRC) {
          this.cpu.writeHooks[config.OCRC] = (value) => {
            this.nextOcrC = this.highByteTemp << 8 | value;
            if (this.ocrUpdateMode === OCRUpdateMode.Immediate) {
              this.ocrC = this.nextOcrC;
            }
          };
        }
        if (this.config.bits === 16) {
          this.cpu.writeHooks[config.ICR] = (value) => {
            this.icr = this.highByteTemp << 8 | value;
          };
          const updateTempRegister = (value) => {
            this.highByteTemp = value;
          };
          const updateOCRHighRegister = (value, old, addr) => {
            this.highByteTemp = value & this.ocrMask >> 8;
            cpu.data[addr] = this.highByteTemp;
            return true;
          };
          this.cpu.writeHooks[config.TCNT + 1] = updateTempRegister;
          this.cpu.writeHooks[config.OCRA + 1] = updateOCRHighRegister;
          this.cpu.writeHooks[config.OCRB + 1] = updateOCRHighRegister;
          if (this.hasOCRC) {
            this.cpu.writeHooks[config.OCRC + 1] = updateOCRHighRegister;
          }
          this.cpu.writeHooks[config.ICR + 1] = updateTempRegister;
        }
        cpu.writeHooks[config.TCCRA] = (value) => {
          this.cpu.data[config.TCCRA] = value;
          this.updateWGMConfig();
          return true;
        };
        cpu.writeHooks[config.TCCRB] = (value) => {
          if (!config.TCCRC) {
            this.checkForceCompare(value);
            value &= ~(FOCA | FOCB);
          }
          this.cpu.data[config.TCCRB] = value;
          this.updateDivider = true;
          this.cpu.clearClockEvent(this.count);
          this.cpu.addClockEvent(this.count, 0);
          this.updateWGMConfig();
          return true;
        };
        if (config.TCCRC) {
          cpu.writeHooks[config.TCCRC] = (value) => {
            this.checkForceCompare(value);
          };
        }
        cpu.writeHooks[config.TIFR] = (value) => {
          this.cpu.data[config.TIFR] = value;
          this.cpu.clearInterruptByFlag(this.OVF, value);
          this.cpu.clearInterruptByFlag(this.OCFA, value);
          this.cpu.clearInterruptByFlag(this.OCFB, value);
          return true;
        };
        cpu.writeHooks[config.TIMSK] = (value) => {
          this.cpu.updateInterruptEnable(this.OVF, value);
          this.cpu.updateInterruptEnable(this.OCFA, value);
          this.cpu.updateInterruptEnable(this.OCFB, value);
        };
      }
      reset() {
        this.divider = 0;
        this.lastCycle = 0;
        this.ocrA = 0;
        this.nextOcrA = 0;
        this.ocrB = 0;
        this.nextOcrB = 0;
        this.ocrC = 0;
        this.nextOcrC = 0;
        this.icr = 0;
        this.tcnt = 0;
        this.tcntNext = 0;
        this.tcntUpdated = false;
        this.countingUp = false;
        this.updateDivider = true;
      }
      get TCCRA() {
        return this.cpu.data[this.config.TCCRA];
      }
      get TCCRB() {
        return this.cpu.data[this.config.TCCRB];
      }
      get TIMSK() {
        return this.cpu.data[this.config.TIMSK];
      }
      get CS() {
        return this.TCCRB & 7;
      }
      get WGM() {
        const mask = this.config.bits === 16 ? 24 : 8;
        return (this.TCCRB & mask) >> 1 | this.TCCRA & 3;
      }
      get TOP() {
        switch (this.topValue) {
          case TopOCRA:
            return this.ocrA;
          case TopICR:
            return this.icr;
          default:
            return this.topValue;
        }
      }
      get ocrMask() {
        switch (this.topValue) {
          case TopOCRA:
          case TopICR:
            return 65535;
          default:
            return this.topValue;
        }
      }
      /** Expose the raw value of TCNT, for use by the unit tests */
      get debugTCNT() {
        return this.tcnt;
      }
      updateWGMConfig() {
        const { config, WGM } = this;
        const wgmModes = config.bits === 16 ? wgmModes16Bit : wgmModes8Bit;
        const TCCRA = this.cpu.data[config.TCCRA];
        const [timerMode, topValue, ocrUpdateMode, tovUpdateMode, flags] = wgmModes[WGM];
        this.timerMode = timerMode;
        this.topValue = topValue;
        this.ocrUpdateMode = ocrUpdateMode;
        this.tovUpdateMode = tovUpdateMode;
        const pwmMode = timerMode === FastPWM || timerMode === PWMPhaseCorrect || timerMode === PWMPhaseFrequencyCorrect;
        const prevCompA = this.compA;
        this.compA = TCCRA >> 6 & 3;
        if (this.compA === 1 && pwmMode && !(flags & OCToggle)) {
          this.compA = 0;
        }
        if (!!prevCompA !== !!this.compA) {
          this.updateCompA(this.compA ? gpio_1.PinOverrideMode.Enable : gpio_1.PinOverrideMode.None);
        }
        const prevCompB = this.compB;
        this.compB = TCCRA >> 4 & 3;
        if (this.compB === 1 && pwmMode) {
          this.compB = 0;
        }
        if (!!prevCompB !== !!this.compB) {
          this.updateCompB(this.compB ? gpio_1.PinOverrideMode.Enable : gpio_1.PinOverrideMode.None);
        }
        if (this.hasOCRC) {
          const prevCompC = this.compC;
          this.compC = TCCRA >> 2 & 3;
          if (this.compC === 1 && pwmMode) {
            this.compC = 0;
          }
          if (!!prevCompC !== !!this.compC) {
            this.updateCompC(this.compC ? gpio_1.PinOverrideMode.Enable : gpio_1.PinOverrideMode.None);
          }
        }
      }
      phasePwmCount(value, delta) {
        const { ocrA, ocrB, ocrC, hasOCRC, TOP, MAX, tcntUpdated } = this;
        if (!value && !TOP) {
          delta = 0;
          if (this.ocrUpdateMode === OCRUpdateMode.Top) {
            this.ocrA = this.nextOcrA;
            this.ocrB = this.nextOcrB;
            this.ocrC = this.nextOcrC;
          }
        }
        while (delta > 0) {
          if (this.countingUp) {
            value++;
            if (value === TOP && !tcntUpdated) {
              this.countingUp = false;
              if (this.ocrUpdateMode === OCRUpdateMode.Top) {
                this.ocrA = this.nextOcrA;
                this.ocrB = this.nextOcrB;
                this.ocrC = this.nextOcrC;
              }
            }
          } else {
            value--;
            if (!value && !tcntUpdated) {
              this.countingUp = true;
              this.cpu.setInterruptFlag(this.OVF);
              if (this.ocrUpdateMode === OCRUpdateMode.Bottom) {
                this.ocrA = this.nextOcrA;
                this.ocrB = this.nextOcrB;
                this.ocrC = this.nextOcrC;
              }
            }
          }
          if (!tcntUpdated) {
            if (value === ocrA) {
              this.cpu.setInterruptFlag(this.OCFA);
              if (this.compA) {
                this.updateCompPin(this.compA, "A");
              }
            }
            if (value === ocrB) {
              this.cpu.setInterruptFlag(this.OCFB);
              if (this.compB) {
                this.updateCompPin(this.compB, "B");
              }
            }
            if (hasOCRC && value === ocrC) {
              this.cpu.setInterruptFlag(this.OCFC);
              if (this.compC) {
                this.updateCompPin(this.compC, "C");
              }
            }
          }
          delta--;
        }
        return value & MAX;
      }
      timerUpdated(value, prevValue) {
        const { ocrA, ocrB, ocrC, hasOCRC } = this;
        const overflow = prevValue > value;
        if ((prevValue < ocrA || overflow) && value >= ocrA || prevValue < ocrA && overflow) {
          this.cpu.setInterruptFlag(this.OCFA);
          if (this.compA) {
            this.updateCompPin(this.compA, "A");
          }
        }
        if ((prevValue < ocrB || overflow) && value >= ocrB || prevValue < ocrB && overflow) {
          this.cpu.setInterruptFlag(this.OCFB);
          if (this.compB) {
            this.updateCompPin(this.compB, "B");
          }
        }
        if (hasOCRC && ((prevValue < ocrC || overflow) && value >= ocrC || prevValue < ocrC && overflow)) {
          this.cpu.setInterruptFlag(this.OCFC);
          if (this.compC) {
            this.updateCompPin(this.compC, "C");
          }
        }
      }
      checkForceCompare(value) {
        if (this.timerMode == TimerMode.FastPWM || this.timerMode == TimerMode.PWMPhaseCorrect || this.timerMode == TimerMode.PWMPhaseFrequencyCorrect) {
          return;
        }
        if (value & FOCA) {
          this.updateCompPin(this.compA, "A");
        }
        if (value & FOCB) {
          this.updateCompPin(this.compB, "B");
        }
        if (this.config.compPortC && value & FOCC) {
          this.updateCompPin(this.compC, "C");
        }
      }
      updateCompPin(compValue, pinName, bottom = false) {
        let newValue = gpio_1.PinOverrideMode.None;
        const invertingMode = compValue === 3;
        const isSet = this.countingUp === invertingMode;
        switch (this.timerMode) {
          case Normal:
          case CTC:
            newValue = compToOverride(compValue);
            break;
          case FastPWM:
            if (compValue === 1) {
              newValue = bottom ? gpio_1.PinOverrideMode.None : gpio_1.PinOverrideMode.Toggle;
            } else {
              newValue = invertingMode !== bottom ? gpio_1.PinOverrideMode.Set : gpio_1.PinOverrideMode.Clear;
            }
            break;
          case PWMPhaseCorrect:
          case PWMPhaseFrequencyCorrect:
            if (compValue === 1) {
              newValue = gpio_1.PinOverrideMode.Toggle;
            } else {
              newValue = isSet ? gpio_1.PinOverrideMode.Set : gpio_1.PinOverrideMode.Clear;
            }
            break;
        }
        if (newValue !== gpio_1.PinOverrideMode.None) {
          if (pinName === "A") {
            this.updateCompA(newValue);
          } else if (pinName === "B") {
            this.updateCompB(newValue);
          } else {
            this.updateCompC(newValue);
          }
        }
      }
      updateCompA(value) {
        const { compPortA, compPinA } = this.config;
        const port = this.cpu.gpioByPort[compPortA];
        port === null || port === void 0 ? void 0 : port.timerOverridePin(compPinA, value);
      }
      updateCompB(value) {
        const { compPortB, compPinB } = this.config;
        const port = this.cpu.gpioByPort[compPortB];
        port === null || port === void 0 ? void 0 : port.timerOverridePin(compPinB, value);
      }
      updateCompC(value) {
        const { compPortC, compPinC } = this.config;
        const port = this.cpu.gpioByPort[compPortC];
        port === null || port === void 0 ? void 0 : port.timerOverridePin(compPinC, value);
      }
    };
    exports.AVRTimer = AVRTimer2;
  }
});

// desktop/apps/desktop/node_modules/avr8js/dist/cjs/peripherals/timer-attiny.js
var require_timer_attiny = __commonJS({
  "desktop/apps/desktop/node_modules/avr8js/dist/cjs/peripherals/timer-attiny.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.ATtinyTimer1 = exports.attinyTimer1Config = void 0;
    var gpio_1 = require_gpio();
    var CTC1 = 1 << 7;
    var PWM1A = 1 << 6;
    var CS_MASK = 15;
    var PWM1B_BIT = 1 << 6;
    var FOC1B = 1 << 3;
    var FOC1A = 1 << 2;
    var PSR1 = 1 << 1;
    exports.attinyTimer1Config = {
      TCCR1: 80,
      GTCCR: 76,
      TCNT1: 79,
      OCR1A: 78,
      OCR1B: 75,
      OCR1C: 77,
      TIFR: 88,
      TIMSK: 89,
      ovfInterrupt: 4,
      compAInterrupt: 3,
      compBInterrupt: 9,
      TOV1: 1 << 2,
      OCF1A: 1 << 6,
      OCF1B: 1 << 5,
      TOIE1: 1 << 2,
      OCIE1A: 1 << 6,
      OCIE1B: 1 << 5,
      compPortB: 56,
      compPinA: 1,
      // PB1
      compPinB: 4,
      // PB4
      dividers: {
        0: 0,
        1: 1,
        2: 2,
        3: 4,
        4: 8,
        5: 16,
        6: 32,
        7: 64,
        8: 128,
        9: 256,
        10: 512,
        11: 1024,
        12: 2048,
        13: 4096,
        14: 8192,
        15: 16384
      }
    };
    var ATtinyTimer1 = class {
      constructor(cpu, config) {
        this.cpu = cpu;
        this.config = config;
        this.lastCycle = 0;
        this.tcnt = 0;
        this.tcntNext = 0;
        this.tcntUpdated = false;
        this.ocrA = 0;
        this.ocrB = 0;
        this.ocrC = 0;
        this.divider = 0;
        this.updateDivider = false;
        this.countingUp = true;
        this.OVF = {
          address: this.config.ovfInterrupt,
          flagRegister: this.config.TIFR,
          flagMask: this.config.TOV1,
          enableRegister: this.config.TIMSK,
          enableMask: this.config.TOIE1
        };
        this.OCFA = {
          address: this.config.compAInterrupt,
          flagRegister: this.config.TIFR,
          flagMask: this.config.OCF1A,
          enableRegister: this.config.TIMSK,
          enableMask: this.config.OCIE1A
        };
        this.OCFB = {
          address: this.config.compBInterrupt,
          flagRegister: this.config.TIFR,
          flagMask: this.config.OCF1B,
          enableRegister: this.config.TIMSK,
          enableMask: this.config.OCIE1B
        };
        this.count = (reschedule = true) => {
          var _a;
          const { divider, lastCycle, cpu: cpu2 } = this;
          const { cycles } = cpu2;
          const delta = cycles - lastCycle;
          if (divider && delta >= divider) {
            const counterDelta = Math.floor(delta / divider);
            this.lastCycle += counterDelta * divider;
            const val = this.tcnt;
            const top = this.TOP;
            const phasePwm = (this.pwmA || this.pwmB) && !this.ctcMode;
            const newVal = phasePwm ? this.phasePwmCount(val, counterDelta) : (val + counterDelta) % (top + 1);
            const overflow = val + counterDelta > top;
            if (!this.tcntUpdated) {
              this.tcnt = newVal;
              if (!phasePwm) {
                this.timerUpdated(newVal, val);
              }
            }
            if (!phasePwm && overflow) {
              cpu2.setInterruptFlag(this.OVF);
            }
          }
          if (this.tcntUpdated) {
            this.tcnt = this.tcntNext;
            this.tcntUpdated = false;
          }
          if (this.updateDivider) {
            const cs = this.CS;
            const newDivider = (_a = this.config.dividers[cs]) !== null && _a !== void 0 ? _a : 0;
            this.lastCycle = newDivider ? this.cpu.cycles : 0;
            this.updateDivider = false;
            this.divider = newDivider;
            if (newDivider) {
              cpu2.addClockEvent(this.count, this.lastCycle + newDivider - cpu2.cycles);
            }
            return;
          }
          if (reschedule && divider) {
            cpu2.addClockEvent(this.count, this.lastCycle + divider - cpu2.cycles);
          }
        };
        const { TCCR1, GTCCR, TCNT1, OCR1A, OCR1B, OCR1C, TIFR, TIMSK } = config;
        cpu.readHooks[TCNT1] = () => {
          this.count(false);
          return cpu.data[TCNT1] = this.tcnt & 255;
        };
        cpu.writeHooks[TCNT1] = (value) => {
          this.tcntNext = value;
          this.countingUp = true;
          this.tcntUpdated = true;
          cpu.updateClockEvent(this.count, 0);
          if (this.divider) {
            this.timerUpdated(this.tcntNext, this.tcntNext);
          }
        };
        cpu.writeHooks[OCR1A] = (value) => {
          this.ocrA = value;
        };
        cpu.writeHooks[OCR1B] = (value) => {
          this.ocrB = value;
        };
        cpu.writeHooks[OCR1C] = (value) => {
          this.ocrC = value;
        };
        cpu.writeHooks[TCCR1] = (value) => {
          cpu.data[TCCR1] = value;
          this.updateDivider = true;
          cpu.clearClockEvent(this.count);
          cpu.addClockEvent(this.count, 0);
          this.updateCompConfig();
          return true;
        };
        const prevGtccrHook = cpu.writeHooks[GTCCR];
        cpu.writeHooks[GTCCR] = (value, oldValue, addr, mask) => {
          if (value & FOC1A) {
            this.forceCompare("A");
          }
          if (value & FOC1B) {
            this.forceCompare("B");
          }
          if (value & PSR1) {
            this.lastCycle = this.cpu.cycles;
          }
          value &= ~(FOC1A | FOC1B | PSR1);
          if (prevGtccrHook) {
            prevGtccrHook(value, oldValue, addr, mask);
          } else {
            cpu.data[GTCCR] = value;
          }
          this.updateCompConfig();
          return true;
        };
        const prevTifrHook = cpu.writeHooks[TIFR];
        cpu.writeHooks[TIFR] = (value, oldValue, addr, mask) => {
          if (prevTifrHook) {
            prevTifrHook(value, oldValue, addr, mask);
          } else {
            cpu.data[TIFR] = value;
          }
          cpu.clearInterruptByFlag(this.OVF, value);
          cpu.clearInterruptByFlag(this.OCFA, value);
          cpu.clearInterruptByFlag(this.OCFB, value);
          return true;
        };
        const prevTimskHook = cpu.writeHooks[TIMSK];
        cpu.writeHooks[TIMSK] = (value, oldValue, addr, mask) => {
          if (prevTimskHook) {
            prevTimskHook(value, oldValue, addr, mask);
          }
          cpu.updateInterruptEnable(this.OVF, value);
          cpu.updateInterruptEnable(this.OCFA, value);
          cpu.updateInterruptEnable(this.OCFB, value);
        };
      }
      get tccr1() {
        return this.cpu.data[this.config.TCCR1];
      }
      get gtccr() {
        return this.cpu.data[this.config.GTCCR];
      }
      get CS() {
        return this.tccr1 & CS_MASK;
      }
      get ctcMode() {
        return !!(this.tccr1 & CTC1);
      }
      get pwmA() {
        return !!(this.tccr1 & PWM1A);
      }
      get pwmB() {
        return !!(this.gtccr & PWM1B_BIT);
      }
      get comA() {
        return this.tccr1 >> 4 & 3;
      }
      get comB() {
        return this.gtccr >> 4 & 3;
      }
      /** TOP = OCR1C in CTC/PWM modes, 0xFF in Normal mode */
      get TOP() {
        if (this.ctcMode || this.pwmA || this.pwmB) {
          return this.ocrC;
        }
        return 255;
      }
      phasePwmCount(value, delta) {
        const top = this.TOP;
        while (delta > 0) {
          if (this.countingUp) {
            value++;
            if (value >= top) {
              value = top;
              this.countingUp = false;
            }
          } else {
            value--;
            if (value <= 0) {
              value = 0;
              this.countingUp = true;
              this.cpu.setInterruptFlag(this.OVF);
            }
          }
          if (!this.tcntUpdated) {
            if (value === this.ocrA) {
              this.cpu.setInterruptFlag(this.OCFA);
              this.updateCompPinPwm("A");
            }
            if (value === this.ocrB) {
              this.cpu.setInterruptFlag(this.OCFB);
              this.updateCompPinPwm("B");
            }
          }
          delta--;
        }
        return value & 255;
      }
      timerUpdated(value, prevValue) {
        const { ocrA, ocrB } = this;
        const overflow = prevValue > value;
        if ((prevValue < ocrA || overflow) && value >= ocrA || prevValue < ocrA && overflow) {
          this.cpu.setInterruptFlag(this.OCFA);
          if (this.comA && !this.pwmA) {
            this.updateCompPinNonPwm("A");
          }
        }
        if ((prevValue < ocrB || overflow) && value >= ocrB || prevValue < ocrB && overflow) {
          this.cpu.setInterruptFlag(this.OCFB);
          if (this.comB && !this.pwmB) {
            this.updateCompPinNonPwm("B");
          }
        }
      }
      forceCompare(channel) {
        if (channel === "A" && !this.pwmA && this.comA) {
          this.updateCompPinNonPwm("A");
        } else if (channel === "B" && !this.pwmB && this.comB) {
          this.updateCompPinNonPwm("B");
        }
      }
      updateCompPinNonPwm(channel) {
        var _a;
        const com = channel === "A" ? this.comA : this.comB;
        const pin = channel === "A" ? this.config.compPinA : this.config.compPinB;
        let mode;
        switch (com) {
          case 1:
            mode = gpio_1.PinOverrideMode.Toggle;
            break;
          case 2:
            mode = gpio_1.PinOverrideMode.Clear;
            break;
          case 3:
            mode = gpio_1.PinOverrideMode.Set;
            break;
          default:
            return;
        }
        (_a = this.cpu.gpioByPort[this.config.compPortB]) === null || _a === void 0 ? void 0 : _a.timerOverridePin(pin, mode);
      }
      updateCompPinPwm(channel) {
        var _a;
        const com = channel === "A" ? this.comA : this.comB;
        const pin = channel === "A" ? this.config.compPinA : this.config.compPinB;
        const invertingMode = com === 3;
        const isSet = this.countingUp === invertingMode;
        let mode;
        switch (com) {
          case 1:
            mode = gpio_1.PinOverrideMode.Toggle;
            break;
          case 2:
          case 3:
            mode = isSet ? gpio_1.PinOverrideMode.Set : gpio_1.PinOverrideMode.Clear;
            break;
          default:
            return;
        }
        (_a = this.cpu.gpioByPort[this.config.compPortB]) === null || _a === void 0 ? void 0 : _a.timerOverridePin(pin, mode);
      }
      updateCompConfig() {
        const port = this.cpu.gpioByPort[this.config.compPortB];
        if (!port)
          return;
        port.timerOverridePin(this.config.compPinA, this.comA ? gpio_1.PinOverrideMode.Enable : gpio_1.PinOverrideMode.None);
        port.timerOverridePin(this.config.compPinB, this.comB ? gpio_1.PinOverrideMode.Enable : gpio_1.PinOverrideMode.None);
      }
    };
    exports.ATtinyTimer1 = ATtinyTimer1;
  }
});

// desktop/apps/desktop/node_modules/avr8js/dist/cjs/peripherals/twi.js
var require_twi = __commonJS({
  "desktop/apps/desktop/node_modules/avr8js/dist/cjs/peripherals/twi.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.AVRTWI = exports.NoopTWIEventHandler = exports.twiConfig = void 0;
    var TWCR_TWINT = 128;
    var TWCR_TWEA = 64;
    var TWCR_TWSTA = 32;
    var TWCR_TWSTO = 16;
    var TWCR_TWEN = 4;
    var TWCR_TWIE = 1;
    var TWSR_TWS_MASK = 248;
    var TWSR_TWPS1 = 2;
    var TWSR_TWPS0 = 1;
    var TWSR_TWPS_MASK = TWSR_TWPS1 | TWSR_TWPS0;
    var STATUS_TWI_IDLE = 248;
    var STATUS_START = 8;
    var STATUS_REPEATED_START = 16;
    var STATUS_SLAW_ACK = 24;
    var STATUS_SLAW_NACK = 32;
    var STATUS_DATA_SENT_ACK = 40;
    var STATUS_DATA_SENT_NACK = 48;
    var STATUS_SLAR_ACK = 64;
    var STATUS_SLAR_NACK = 72;
    var STATUS_DATA_RECEIVED_ACK = 80;
    var STATUS_DATA_RECEIVED_NACK = 88;
    exports.twiConfig = {
      twiInterrupt: 48,
      TWBR: 184,
      TWSR: 185,
      TWAR: 186,
      TWDR: 187,
      TWCR: 188,
      TWAMR: 189
    };
    var NoopTWIEventHandler = class {
      constructor(twi) {
        this.twi = twi;
      }
      start() {
        this.twi.completeStart();
      }
      stop() {
        this.twi.completeStop();
      }
      connectToSlave() {
        this.twi.completeConnect(false);
      }
      writeByte() {
        this.twi.completeWrite(false);
      }
      readByte() {
        this.twi.completeRead(255);
      }
    };
    exports.NoopTWIEventHandler = NoopTWIEventHandler;
    var AVRTWI = class {
      constructor(cpu, config, freqHz) {
        this.cpu = cpu;
        this.config = config;
        this.freqHz = freqHz;
        this.eventHandler = new NoopTWIEventHandler(this);
        this.busy = false;
        this.TWI = {
          address: this.config.twiInterrupt,
          flagRegister: this.config.TWCR,
          flagMask: TWCR_TWINT,
          enableRegister: this.config.TWCR,
          enableMask: TWCR_TWIE
        };
        this.updateStatus(STATUS_TWI_IDLE);
        this.cpu.writeHooks[config.TWCR] = (value) => {
          this.cpu.data[config.TWCR] = value;
          const clearInt = value & TWCR_TWINT;
          this.cpu.clearInterruptByFlag(this.TWI, value);
          this.cpu.updateInterruptEnable(this.TWI, value);
          const { status } = this;
          if (clearInt && value & TWCR_TWEN && !this.busy) {
            const twdrValue = this.cpu.data[this.config.TWDR];
            this.cpu.addClockEvent(() => {
              if (value & TWCR_TWSTA) {
                this.busy = true;
                this.eventHandler.start(status !== STATUS_TWI_IDLE);
              } else if (value & TWCR_TWSTO) {
                this.busy = true;
                this.eventHandler.stop();
              } else if (status === STATUS_START || status === STATUS_REPEATED_START) {
                this.busy = true;
                this.eventHandler.connectToSlave(twdrValue >> 1, twdrValue & 1 ? false : true);
              } else if (status === STATUS_SLAW_ACK || status === STATUS_DATA_SENT_ACK) {
                this.busy = true;
                this.eventHandler.writeByte(twdrValue);
              } else if (status === STATUS_SLAR_ACK || status === STATUS_DATA_RECEIVED_ACK) {
                this.busy = true;
                const ack = !!(value & TWCR_TWEA);
                this.eventHandler.readByte(ack);
              }
            }, 0);
            return true;
          }
        };
      }
      get prescaler() {
        switch (this.cpu.data[this.config.TWSR] & TWSR_TWPS_MASK) {
          case 0:
            return 1;
          case 1:
            return 4;
          case 2:
            return 16;
          case 3:
            return 64;
        }
        throw new Error("Invalid prescaler value!");
      }
      get sclFrequency() {
        return this.freqHz / (16 + 2 * this.cpu.data[this.config.TWBR] * this.prescaler);
      }
      completeStart() {
        this.busy = false;
        this.updateStatus(this.status === STATUS_TWI_IDLE ? STATUS_START : STATUS_REPEATED_START);
      }
      completeStop() {
        this.busy = false;
        this.cpu.data[this.config.TWCR] &= ~TWCR_TWSTO;
        this.updateStatus(STATUS_TWI_IDLE);
      }
      completeConnect(ack) {
        this.busy = false;
        if (this.cpu.data[this.config.TWDR] & 1) {
          this.updateStatus(ack ? STATUS_SLAR_ACK : STATUS_SLAR_NACK);
        } else {
          this.updateStatus(ack ? STATUS_SLAW_ACK : STATUS_SLAW_NACK);
        }
      }
      completeWrite(ack) {
        this.busy = false;
        this.updateStatus(ack ? STATUS_DATA_SENT_ACK : STATUS_DATA_SENT_NACK);
      }
      completeRead(value) {
        this.busy = false;
        const ack = !!(this.cpu.data[this.config.TWCR] & TWCR_TWEA);
        this.cpu.data[this.config.TWDR] = value;
        this.updateStatus(ack ? STATUS_DATA_RECEIVED_ACK : STATUS_DATA_RECEIVED_NACK);
      }
      get status() {
        return this.cpu.data[this.config.TWSR] & TWSR_TWS_MASK;
      }
      updateStatus(value) {
        const { TWSR } = this.config;
        this.cpu.data[TWSR] = this.cpu.data[TWSR] & ~TWSR_TWS_MASK | value;
        this.cpu.setInterruptFlag(this.TWI);
      }
    };
    exports.AVRTWI = AVRTWI;
  }
});

// desktop/apps/desktop/node_modules/avr8js/dist/cjs/peripherals/usart.js
var require_usart = __commonJS({
  "desktop/apps/desktop/node_modules/avr8js/dist/cjs/peripherals/usart.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.AVRUSART = exports.usart0Config = void 0;
    exports.usart0Config = {
      rxCompleteInterrupt: 36,
      dataRegisterEmptyInterrupt: 38,
      txCompleteInterrupt: 40,
      UCSRA: 192,
      UCSRB: 193,
      UCSRC: 194,
      UBRRL: 196,
      UBRRH: 197,
      UDR: 198
    };
    var UCSRA_RXC = 128;
    var UCSRA_TXC = 64;
    var UCSRA_UDRE = 32;
    var UCSRA_U2X = 2;
    var UCSRA_MPCM = 1;
    var UCSRA_CFG_MASK = UCSRA_U2X;
    var UCSRB_RXCIE = 128;
    var UCSRB_TXCIE = 64;
    var UCSRB_UDRIE = 32;
    var UCSRB_RXEN = 16;
    var UCSRB_TXEN = 8;
    var UCSRB_UCSZ2 = 4;
    var UCSRB_CFG_MASK = UCSRB_UCSZ2 | UCSRB_RXEN | UCSRB_TXEN;
    var UCSRC_UPM1 = 32;
    var UCSRC_UPM0 = 16;
    var UCSRC_USBS = 8;
    var UCSRC_UCSZ1 = 4;
    var UCSRC_UCSZ0 = 2;
    var rxMasks = {
      5: 31,
      6: 63,
      7: 127,
      8: 255,
      9: 255
    };
    var AVRUSART2 = class {
      constructor(cpu, config, freqHz) {
        this.cpu = cpu;
        this.config = config;
        this.freqHz = freqHz;
        this.onByteTransmit = null;
        this.onLineTransmit = null;
        this.onRxComplete = null;
        this.onConfigurationChange = null;
        this.rxBusyValue = false;
        this.rxByte = 0;
        this.lineBuffer = "";
        this.RXC = {
          address: this.config.rxCompleteInterrupt,
          flagRegister: this.config.UCSRA,
          flagMask: UCSRA_RXC,
          enableRegister: this.config.UCSRB,
          enableMask: UCSRB_RXCIE,
          constant: true
        };
        this.UDRE = {
          address: this.config.dataRegisterEmptyInterrupt,
          flagRegister: this.config.UCSRA,
          flagMask: UCSRA_UDRE,
          enableRegister: this.config.UCSRB,
          enableMask: UCSRB_UDRIE
        };
        this.TXC = {
          address: this.config.txCompleteInterrupt,
          flagRegister: this.config.UCSRA,
          flagMask: UCSRA_TXC,
          enableRegister: this.config.UCSRB,
          enableMask: UCSRB_TXCIE
        };
        this.reset();
        this.cpu.writeHooks[config.UCSRA] = (value, oldValue) => {
          var _a;
          cpu.data[config.UCSRA] = value & (UCSRA_MPCM | UCSRA_U2X);
          cpu.clearInterruptByFlag(this.TXC, value);
          if ((value & UCSRA_CFG_MASK) !== (oldValue & UCSRA_CFG_MASK)) {
            (_a = this.onConfigurationChange) === null || _a === void 0 ? void 0 : _a.call(this);
          }
          return true;
        };
        this.cpu.writeHooks[config.UCSRB] = (value, oldValue) => {
          var _a;
          cpu.updateInterruptEnable(this.RXC, value);
          cpu.updateInterruptEnable(this.UDRE, value);
          cpu.updateInterruptEnable(this.TXC, value);
          if (value & UCSRB_RXEN && oldValue & UCSRB_RXEN) {
            cpu.clearInterrupt(this.RXC);
          }
          if (value & UCSRB_TXEN && !(oldValue & UCSRB_TXEN)) {
            cpu.setInterruptFlag(this.UDRE);
          }
          cpu.data[config.UCSRB] = value;
          if ((value & UCSRB_CFG_MASK) !== (oldValue & UCSRB_CFG_MASK)) {
            (_a = this.onConfigurationChange) === null || _a === void 0 ? void 0 : _a.call(this);
          }
          return true;
        };
        this.cpu.writeHooks[config.UCSRC] = (value) => {
          var _a;
          cpu.data[config.UCSRC] = value;
          (_a = this.onConfigurationChange) === null || _a === void 0 ? void 0 : _a.call(this);
          return true;
        };
        this.cpu.readHooks[config.UDR] = () => {
          var _a;
          const mask = (_a = rxMasks[this.bitsPerChar]) !== null && _a !== void 0 ? _a : 255;
          const result = this.rxByte & mask;
          this.rxByte = 0;
          this.cpu.clearInterrupt(this.RXC);
          return result;
        };
        this.cpu.writeHooks[config.UDR] = (value) => {
          if (this.onByteTransmit) {
            this.onByteTransmit(value);
          }
          if (this.onLineTransmit) {
            const ch = String.fromCharCode(value);
            if (ch === "\n") {
              this.onLineTransmit(this.lineBuffer);
              this.lineBuffer = "";
            } else {
              this.lineBuffer += ch;
            }
          }
          this.cpu.addClockEvent(() => {
            cpu.setInterruptFlag(this.UDRE);
            cpu.setInterruptFlag(this.TXC);
          }, this.cyclesPerChar);
          this.cpu.clearInterrupt(this.TXC);
          this.cpu.clearInterrupt(this.UDRE);
        };
        this.cpu.writeHooks[config.UBRRH] = (value) => {
          var _a;
          this.cpu.data[config.UBRRH] = value;
          (_a = this.onConfigurationChange) === null || _a === void 0 ? void 0 : _a.call(this);
          return true;
        };
        this.cpu.writeHooks[config.UBRRL] = (value) => {
          var _a;
          this.cpu.data[config.UBRRL] = value;
          (_a = this.onConfigurationChange) === null || _a === void 0 ? void 0 : _a.call(this);
          return true;
        };
      }
      reset() {
        this.cpu.data[this.config.UCSRA] = UCSRA_UDRE;
        this.cpu.data[this.config.UCSRB] = 0;
        this.cpu.data[this.config.UCSRC] = UCSRC_UCSZ1 | UCSRC_UCSZ0;
        this.rxBusyValue = false;
        this.rxByte = 0;
        this.lineBuffer = "";
      }
      get rxBusy() {
        return this.rxBusyValue;
      }
      writeByte(value, immediate = false) {
        var _a;
        const { cpu } = this;
        if (this.rxBusyValue || !this.rxEnable) {
          return false;
        }
        if (immediate) {
          this.rxByte = value;
          cpu.setInterruptFlag(this.RXC);
          (_a = this.onRxComplete) === null || _a === void 0 ? void 0 : _a.call(this);
        } else {
          this.rxBusyValue = true;
          cpu.addClockEvent(() => {
            this.rxBusyValue = false;
            this.writeByte(value, true);
          }, this.cyclesPerChar);
          return true;
        }
      }
      get cyclesPerChar() {
        const symbolsPerChar = 1 + this.bitsPerChar + this.stopBits + (this.parityEnabled ? 1 : 0);
        return (this.UBRR + 1) * this.multiplier * symbolsPerChar;
      }
      get UBRR() {
        const { UBRRH, UBRRL } = this.config;
        return this.cpu.data[UBRRH] << 8 | this.cpu.data[UBRRL];
      }
      get multiplier() {
        return this.cpu.data[this.config.UCSRA] & UCSRA_U2X ? 8 : 16;
      }
      get rxEnable() {
        return !!(this.cpu.data[this.config.UCSRB] & UCSRB_RXEN);
      }
      get txEnable() {
        return !!(this.cpu.data[this.config.UCSRB] & UCSRB_TXEN);
      }
      get baudRate() {
        return Math.floor(this.freqHz / (this.multiplier * (1 + this.UBRR)));
      }
      get bitsPerChar() {
        const ucsz = (this.cpu.data[this.config.UCSRC] & (UCSRC_UCSZ1 | UCSRC_UCSZ0)) >> 1 | this.cpu.data[this.config.UCSRB] & UCSRB_UCSZ2;
        switch (ucsz) {
          case 0:
            return 5;
          case 1:
            return 6;
          case 2:
            return 7;
          case 3:
            return 8;
          default:
          // 4..6 are reserved
          case 7:
            return 9;
        }
      }
      get stopBits() {
        return this.cpu.data[this.config.UCSRC] & UCSRC_USBS ? 2 : 1;
      }
      get parityEnabled() {
        return this.cpu.data[this.config.UCSRC] & UCSRC_UPM1 ? true : false;
      }
      get parityOdd() {
        return this.cpu.data[this.config.UCSRC] & UCSRC_UPM0 ? true : false;
      }
    };
    exports.AVRUSART = AVRUSART2;
  }
});

// desktop/apps/desktop/node_modules/avr8js/dist/cjs/peripherals/usi.js
var require_usi = __commonJS({
  "desktop/apps/desktop/node_modules/avr8js/dist/cjs/peripherals/usi.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.AVRUSI = void 0;
    var USICR = 45;
    var USISR = 46;
    var USIDR = 47;
    var USIBR = 48;
    var USICNT_MASK = 15;
    var USIDC = 1 << 4;
    var USIPF = 1 << 5;
    var USIOIF = 1 << 6;
    var USISIF = 1 << 7;
    var USITC = 1 << 0;
    var USICLK = 1 << 1;
    var USICS0 = 1 << 2;
    var USICS1 = 1 << 3;
    var USIWM0 = 1 << 4;
    var USIWM1 = 1 << 5;
    var USIOIE = 1 << 6;
    var USISIE = 1 << 7;
    var AVRUSI = class {
      constructor(cpu, port, portPin, dataPin, clockPin) {
        this.START = {
          address: 13,
          flagRegister: USISR,
          flagMask: USISIF,
          enableRegister: USICR,
          enableMask: USISIE
        };
        this.OVF = {
          address: 14,
          flagRegister: USISR,
          flagMask: USIOIF,
          enableRegister: USICR,
          enableMask: USIOIE
        };
        const PIN = portPin;
        const PORT = PIN + 2;
        port.addListener((value) => {
          const twoWire = (cpu.data[USICR] & USIWM1) === USIWM1;
          if (twoWire) {
            if (value & 1 << clockPin && !(value & 1 << dataPin)) {
              cpu.setInterruptFlag(this.START);
            }
            if (value & 1 << clockPin && value & 1 << dataPin) {
              cpu.data[USISR] |= USIPF;
            }
          }
        });
        const updateOutput = () => {
          const oldValue = cpu.data[PORT];
          const newValue = cpu.data[USIDR] & 128 ? oldValue | 1 << dataPin : oldValue & ~(1 << dataPin);
          cpu.writeHooks[PORT](newValue, oldValue, PORT, 255);
          if (newValue & 128 && !(cpu.data[PIN] & 128)) {
            cpu.data[USISR] |= USIDC;
          } else {
            cpu.data[USISR] &= ~USIDC;
          }
        };
        const count = () => {
          const counter = cpu.data[USISR] + 1 & USICNT_MASK;
          cpu.data[USISR] = cpu.data[USISR] & ~USICNT_MASK | counter;
          if (!counter) {
            cpu.data[USIBR] = cpu.data[USIDR];
            cpu.setInterruptFlag(this.OVF);
          }
        };
        const shift = (inputValue) => {
          cpu.data[USIDR] = cpu.data[USIDR] << 1 | inputValue;
          updateOutput();
        };
        cpu.writeHooks[USIDR] = (value) => {
          cpu.data[USIDR] = value;
          updateOutput();
          return true;
        };
        cpu.writeHooks[USISR] = (value) => {
          const writeClearMask = USISIF | USIOIF | USIPF;
          cpu.data[USISR] = cpu.data[USISR] & writeClearMask & ~value | value & 15;
          cpu.clearInterruptByFlag(this.START, value);
          cpu.clearInterruptByFlag(this.OVF, value);
          return true;
        };
        cpu.writeHooks[USICR] = (value) => {
          cpu.data[USICR] = value & ~(USICLK | USITC);
          cpu.updateInterruptEnable(this.START, value);
          cpu.updateInterruptEnable(this.OVF, value);
          const clockSrc = value & (USICS1 | USICS0) >> 2;
          const mode = value & (USIWM1 | USIWM0) >> 4;
          const usiClk = value & USICLK;
          port.openCollector = mode >= 2 ? 1 << dataPin : 0;
          const inputValue = cpu.data[PIN] & 1 << dataPin ? 1 : 0;
          if (usiClk && !clockSrc) {
            shift(inputValue);
            count();
          }
          if (value & USITC) {
            cpu.writeHooks[PIN](1 << clockPin, cpu.data[PIN], PIN, 255);
            const newValue = cpu.data[PIN] & 1 << clockPin;
            if (usiClk && (clockSrc === 2 || clockSrc === 3)) {
              if (clockSrc === 2 && newValue) {
                shift(inputValue);
              }
              if (clockSrc === 3 && !newValue) {
                shift(inputValue);
              }
              count();
            }
            return true;
          }
        };
      }
    };
    exports.AVRUSI = AVRUSI;
  }
});

// desktop/apps/desktop/node_modules/avr8js/dist/cjs/peripherals/watchdog.js
var require_watchdog = __commonJS({
  "desktop/apps/desktop/node_modules/avr8js/dist/cjs/peripherals/watchdog.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.AVRWatchdog = exports.watchdogConfig = void 0;
    var MCUSR_WDRF = 8;
    var WDTCSR_WDIF = 128;
    var WDTCSR_WDIE = 64;
    var WDTCSR_WDP3 = 32;
    var WDTCSR_WDCE = 16;
    var WDTCSR_WDE = 8;
    var WDTCSR_WDP2 = 4;
    var WDTCSR_WDP1 = 2;
    var WDTCSR_WDP0 = 1;
    var WDTCSR_WDP210 = WDTCSR_WDP2 | WDTCSR_WDP1 | WDTCSR_WDP0;
    var WDTCSR_PROTECT_MASK = WDTCSR_WDE | WDTCSR_WDP3 | WDTCSR_WDP210;
    exports.watchdogConfig = {
      watchdogInterrupt: 12,
      MCUSR: 84,
      WDTCSR: 96
    };
    var AVRWatchdog = class {
      constructor(cpu, config, clock) {
        this.cpu = cpu;
        this.config = config;
        this.clock = clock;
        this.clockFrequency = 128e3;
        this.changeEnabledCycles = 0;
        this.watchdogTimeout = 0;
        this.enabledValue = false;
        this.scheduled = false;
        this.Watchdog = {
          address: this.config.watchdogInterrupt,
          flagRegister: this.config.WDTCSR,
          flagMask: WDTCSR_WDIF,
          enableRegister: this.config.WDTCSR,
          enableMask: WDTCSR_WDIE
        };
        this.checkWatchdog = () => {
          if (this.enabled && this.cpu.cycles >= this.watchdogTimeout) {
            const wdtcsr = this.cpu.data[this.config.WDTCSR];
            if (wdtcsr & WDTCSR_WDIE) {
              this.cpu.setInterruptFlag(this.Watchdog);
            }
            if (wdtcsr & WDTCSR_WDE) {
              if (wdtcsr & WDTCSR_WDIE) {
                this.cpu.data[this.config.WDTCSR] &= ~WDTCSR_WDIE;
              } else {
                this.cpu.reset();
                this.scheduled = false;
                this.cpu.data[this.config.MCUSR] |= MCUSR_WDRF;
                return;
              }
            }
            this.resetWatchdog();
          }
          if (this.enabled) {
            this.scheduled = true;
            this.cpu.addClockEvent(this.checkWatchdog, this.watchdogTimeout - this.cpu.cycles);
          } else {
            this.scheduled = false;
          }
        };
        const { WDTCSR } = config;
        this.cpu.onWatchdogReset = () => {
          this.resetWatchdog();
        };
        cpu.writeHooks[WDTCSR] = (value, oldValue) => {
          if (value & WDTCSR_WDCE && value & WDTCSR_WDE) {
            this.changeEnabledCycles = this.cpu.cycles + 4;
            value = value & ~WDTCSR_PROTECT_MASK;
          } else {
            if (this.cpu.cycles >= this.changeEnabledCycles) {
              value = value & ~WDTCSR_PROTECT_MASK | oldValue & WDTCSR_PROTECT_MASK;
            }
            this.enabledValue = !!(value & WDTCSR_WDE || value & WDTCSR_WDIE);
            this.cpu.data[WDTCSR] = value;
          }
          if (this.enabled) {
            this.resetWatchdog();
          }
          if (this.enabled && !this.scheduled) {
            this.cpu.addClockEvent(this.checkWatchdog, this.watchdogTimeout - this.cpu.cycles);
          }
          this.cpu.clearInterruptByFlag(this.Watchdog, value);
          return true;
        };
      }
      resetWatchdog() {
        const cycles = Math.floor(this.clock.frequency / this.clockFrequency * this.prescaler);
        this.watchdogTimeout = this.cpu.cycles + cycles;
      }
      get enabled() {
        return this.enabledValue;
      }
      /**
       * The base clock frequency is 128KHz. Thus, a prescaler of 2048 gives 16ms timeout.
       */
      get prescaler() {
        const wdtcsr = this.cpu.data[this.config.WDTCSR];
        const value = (wdtcsr & WDTCSR_WDP3) >> 2 | wdtcsr & WDTCSR_WDP210;
        return 2048 << value;
      }
    };
    exports.AVRWatchdog = AVRWatchdog;
  }
});

// desktop/apps/desktop/node_modules/avr8js/dist/cjs/index.js
var require_cjs = __commonJS({
  "desktop/apps/desktop/node_modules/avr8js/dist/cjs/index.js"(exports) {
    "use strict";
    var __createBinding = exports && exports.__createBinding || (Object.create ? (function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      var desc = Object.getOwnPropertyDescriptor(m, k);
      if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
        desc = { enumerable: true, get: function() {
          return m[k];
        } };
      }
      Object.defineProperty(o, k2, desc);
    }) : (function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      o[k2] = m[k];
    }));
    var __exportStar = exports && exports.__exportStar || function(m, exports2) {
      for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports2, p)) __createBinding(exports2, m, p);
    };
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.watchdogConfig = exports.AVRWatchdog = exports.AVRUSI = exports.usart0Config = exports.AVRUSART = exports.attinyTimer1Config = exports.ATtinyTimer1 = exports.timer2Config = exports.timer1Config = exports.timer0Config = exports.AVRTimer = exports.spiConfig = exports.AVRSPI = exports.portLConfig = exports.portKConfig = exports.portJConfig = exports.portHConfig = exports.portGConfig = exports.portFConfig = exports.portEConfig = exports.portDConfig = exports.portCConfig = exports.portBConfig = exports.portAConfig = exports.PinState = exports.PCINT2 = exports.PCINT1 = exports.PCINT0 = exports.INT1 = exports.INT0 = exports.AVRIOPort = exports.eepromConfig = exports.EEPROMMemoryBackend = exports.AVREEPROM = exports.clockConfig = exports.AVRClock = exports.atmega328Channels = exports.adcConfig = exports.AVRADC = exports.ADCReference = exports.ADCMuxInputType = exports.avrInterrupt = exports.avrInstruction = exports.CPU = void 0;
    var cpu_1 = require_cpu();
    Object.defineProperty(exports, "CPU", { enumerable: true, get: function() {
      return cpu_1.CPU;
    } });
    var instruction_1 = require_instruction();
    Object.defineProperty(exports, "avrInstruction", { enumerable: true, get: function() {
      return instruction_1.avrInstruction;
    } });
    var interrupt_1 = require_interrupt();
    Object.defineProperty(exports, "avrInterrupt", { enumerable: true, get: function() {
      return interrupt_1.avrInterrupt;
    } });
    var adc_1 = require_adc();
    Object.defineProperty(exports, "ADCMuxInputType", { enumerable: true, get: function() {
      return adc_1.ADCMuxInputType;
    } });
    Object.defineProperty(exports, "ADCReference", { enumerable: true, get: function() {
      return adc_1.ADCReference;
    } });
    Object.defineProperty(exports, "AVRADC", { enumerable: true, get: function() {
      return adc_1.AVRADC;
    } });
    Object.defineProperty(exports, "adcConfig", { enumerable: true, get: function() {
      return adc_1.adcConfig;
    } });
    Object.defineProperty(exports, "atmega328Channels", { enumerable: true, get: function() {
      return adc_1.atmega328Channels;
    } });
    var clock_1 = require_clock();
    Object.defineProperty(exports, "AVRClock", { enumerable: true, get: function() {
      return clock_1.AVRClock;
    } });
    Object.defineProperty(exports, "clockConfig", { enumerable: true, get: function() {
      return clock_1.clockConfig;
    } });
    var eeprom_1 = require_eeprom();
    Object.defineProperty(exports, "AVREEPROM", { enumerable: true, get: function() {
      return eeprom_1.AVREEPROM;
    } });
    Object.defineProperty(exports, "EEPROMMemoryBackend", { enumerable: true, get: function() {
      return eeprom_1.EEPROMMemoryBackend;
    } });
    Object.defineProperty(exports, "eepromConfig", { enumerable: true, get: function() {
      return eeprom_1.eepromConfig;
    } });
    var gpio_1 = require_gpio();
    Object.defineProperty(exports, "AVRIOPort", { enumerable: true, get: function() {
      return gpio_1.AVRIOPort;
    } });
    Object.defineProperty(exports, "INT0", { enumerable: true, get: function() {
      return gpio_1.INT0;
    } });
    Object.defineProperty(exports, "INT1", { enumerable: true, get: function() {
      return gpio_1.INT1;
    } });
    Object.defineProperty(exports, "PCINT0", { enumerable: true, get: function() {
      return gpio_1.PCINT0;
    } });
    Object.defineProperty(exports, "PCINT1", { enumerable: true, get: function() {
      return gpio_1.PCINT1;
    } });
    Object.defineProperty(exports, "PCINT2", { enumerable: true, get: function() {
      return gpio_1.PCINT2;
    } });
    Object.defineProperty(exports, "PinState", { enumerable: true, get: function() {
      return gpio_1.PinState;
    } });
    Object.defineProperty(exports, "portAConfig", { enumerable: true, get: function() {
      return gpio_1.portAConfig;
    } });
    Object.defineProperty(exports, "portBConfig", { enumerable: true, get: function() {
      return gpio_1.portBConfig;
    } });
    Object.defineProperty(exports, "portCConfig", { enumerable: true, get: function() {
      return gpio_1.portCConfig;
    } });
    Object.defineProperty(exports, "portDConfig", { enumerable: true, get: function() {
      return gpio_1.portDConfig;
    } });
    Object.defineProperty(exports, "portEConfig", { enumerable: true, get: function() {
      return gpio_1.portEConfig;
    } });
    Object.defineProperty(exports, "portFConfig", { enumerable: true, get: function() {
      return gpio_1.portFConfig;
    } });
    Object.defineProperty(exports, "portGConfig", { enumerable: true, get: function() {
      return gpio_1.portGConfig;
    } });
    Object.defineProperty(exports, "portHConfig", { enumerable: true, get: function() {
      return gpio_1.portHConfig;
    } });
    Object.defineProperty(exports, "portJConfig", { enumerable: true, get: function() {
      return gpio_1.portJConfig;
    } });
    Object.defineProperty(exports, "portKConfig", { enumerable: true, get: function() {
      return gpio_1.portKConfig;
    } });
    Object.defineProperty(exports, "portLConfig", { enumerable: true, get: function() {
      return gpio_1.portLConfig;
    } });
    var spi_1 = require_spi();
    Object.defineProperty(exports, "AVRSPI", { enumerable: true, get: function() {
      return spi_1.AVRSPI;
    } });
    Object.defineProperty(exports, "spiConfig", { enumerable: true, get: function() {
      return spi_1.spiConfig;
    } });
    var timer_1 = require_timer();
    Object.defineProperty(exports, "AVRTimer", { enumerable: true, get: function() {
      return timer_1.AVRTimer;
    } });
    Object.defineProperty(exports, "timer0Config", { enumerable: true, get: function() {
      return timer_1.timer0Config;
    } });
    Object.defineProperty(exports, "timer1Config", { enumerable: true, get: function() {
      return timer_1.timer1Config;
    } });
    Object.defineProperty(exports, "timer2Config", { enumerable: true, get: function() {
      return timer_1.timer2Config;
    } });
    var timer_attiny_1 = require_timer_attiny();
    Object.defineProperty(exports, "ATtinyTimer1", { enumerable: true, get: function() {
      return timer_attiny_1.ATtinyTimer1;
    } });
    Object.defineProperty(exports, "attinyTimer1Config", { enumerable: true, get: function() {
      return timer_attiny_1.attinyTimer1Config;
    } });
    __exportStar(require_twi(), exports);
    var usart_1 = require_usart();
    Object.defineProperty(exports, "AVRUSART", { enumerable: true, get: function() {
      return usart_1.AVRUSART;
    } });
    Object.defineProperty(exports, "usart0Config", { enumerable: true, get: function() {
      return usart_1.usart0Config;
    } });
    var usi_1 = require_usi();
    Object.defineProperty(exports, "AVRUSI", { enumerable: true, get: function() {
      return usi_1.AVRUSI;
    } });
    var watchdog_1 = require_watchdog();
    Object.defineProperty(exports, "AVRWatchdog", { enumerable: true, get: function() {
      return watchdog_1.AVRWatchdog;
    } });
    Object.defineProperty(exports, "watchdogConfig", { enumerable: true, get: function() {
      return watchdog_1.watchdogConfig;
    } });
  }
});

// desktop/apps/desktop/src/services/ai_avr_simulator.ts
var import_avr8js = __toESM(require_cjs(), 1);

// desktop/apps/desktop/src/services/compile_source_map.ts
var SHA256_INITIAL_STATE = [
  1779033703,
  3144134277,
  1013904242,
  2773480762,
  1359893119,
  2600822924,
  528734635,
  1541459225
];
var SHA256_ROUND_CONSTANTS = [
  1116352408,
  1899447441,
  3049323471,
  3921009573,
  961987163,
  1508970993,
  2453635748,
  2870763221,
  3624381080,
  310598401,
  607225278,
  1426881987,
  1925078388,
  2162078206,
  2614888103,
  3248222580,
  3835390401,
  4022224774,
  264347078,
  604807628,
  770255983,
  1249150122,
  1555081692,
  1996064986,
  2554220882,
  2821834349,
  2952996808,
  3210313671,
  3336571891,
  3584528711,
  113926993,
  338241895,
  666307205,
  773529912,
  1294757372,
  1396182291,
  1695183700,
  1986661051,
  2177026350,
  2456956037,
  2730485921,
  2820302411,
  3259730800,
  3345764771,
  3516065817,
  3600352804,
  4094571909,
  275423344,
  430227734,
  506948616,
  659060556,
  883997877,
  958139571,
  1322822218,
  1537002063,
  1747873779,
  1955562222,
  2024104815,
  2227730452,
  2361852424,
  2428436474,
  2756734187,
  3204031479,
  3329325298
];
var rotateRight = (value, amount) => value >>> amount | value << 32 - amount;
var sha256Hex = (source) => {
  const input = new TextEncoder().encode(String(source ?? ""));
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(input);
  padded[input.length] = 128;
  const bitLength = input.length * 8;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 4294967296), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);
  const state = Array.from(SHA256_INITIAL_STATE, (value) => value >>> 0);
  const schedule = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      schedule[index] = view.getUint32(offset + index * 4, false);
    }
    for (let index = 16; index < 64; index += 1) {
      const previous15 = schedule[index - 15];
      const previous2 = schedule[index - 2];
      const sigma0 = rotateRight(previous15, 7) ^ rotateRight(previous15, 18) ^ previous15 >>> 3;
      const sigma1 = rotateRight(previous2, 17) ^ rotateRight(previous2, 19) ^ previous2 >>> 10;
      schedule[index] = schedule[index - 16] + sigma0 + schedule[index - 7] + sigma1 >>> 0;
    }
    let a = state[0];
    let b = state[1];
    let c = state[2];
    let d = state[3];
    let e = state[4];
    let f = state[5];
    let g = state[6];
    let h = state[7];
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = e & f ^ ~e & g;
      const temp1 = h + sum1 + choose + SHA256_ROUND_CONSTANTS[index] + schedule[index] >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = a & b ^ a & c ^ b & c;
      const temp2 = sum0 + majority >>> 0;
      h = g;
      g = f;
      f = e;
      e = d + temp1 >>> 0;
      d = c;
      c = b;
      b = a;
      a = temp1 + temp2 >>> 0;
    }
    state[0] = state[0] + a >>> 0;
    state[1] = state[1] + b >>> 0;
    state[2] = state[2] + c >>> 0;
    state[3] = state[3] + d >>> 0;
    state[4] = state[4] + e >>> 0;
    state[5] = state[5] + f >>> 0;
    state[6] = state[6] + g >>> 0;
    state[7] = state[7] + h >>> 0;
  }
  return state.map((value) => value.toString(16).padStart(8, "0")).join("");
};

// desktop/apps/desktop/src/services/ai_acceptance.ts
var AI_BEHAVIOR_LIMITS = { scenarios: 6, perScenarioMs: 5e3, totalMs: 12e3, wallMs: 6e4, assertions: 128, inputs: 256 };
var plain = (v) => !!v && typeof v === "object" && !Array.isArray(v);
var require2 = (ok, message) => {
  if (!ok) throw Error(message);
};
function shape(v, keys, label) {
  require2(plain(v) && Object.keys(v).every((k) => keys.includes(k)), `${label}\u542B\u672A\u77E5\u5B57\u6BB5\u6216\u4E0D\u662F\u5BF9\u8C61`);
}
var text = (v, max) => typeof v === "string" && !!v.trim() && v.length <= max && !v.includes("\0");
var id = (v) => typeof v === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(v);
var integer = (v, min, max) => Number.isSafeInteger(v) && Number(v) >= min && Number(v) <= max;
function aiSimulationTarget(target) {
  const fqbn = typeof target === "string" ? target : plain(target) ? target.fqbn : void 0;
  if (typeof fqbn !== "string") return null;
  const [pkg, arch, board, options = "", ...rest] = fqbn.split(":");
  if (rest.length || pkg !== "arduino" || arch !== "avr" || !["uno", "nano"].includes(board)) return null;
  const pairs = options ? options.split(",") : [];
  if (pairs.some((p) => !/^cpu=atmega328(?:old)?$/.test(p)) || pairs.length > 1 || board === "uno" && pairs.length) return null;
  return "atmega328p-16mhz";
}
function parseAiAcceptance(value) {
  shape(value, ["version", "requirements", "scenarios"], "\u9A8C\u6536\u8BA1\u5212");
  require2(value.version === 1, "\u9A8C\u6536\u8BA1\u5212version\u5FC5\u987B\u4E3A1");
  require2(Array.isArray(value.requirements) && value.requirements.length > 0 && value.requirements.length <= 24, "\u9A8C\u6536\u6761\u4EF6\u9700\u89811\u201324\u9879");
  const ids = /* @__PURE__ */ new Set();
  const requirements = value.requirements.map((r) => {
    shape(r, ["id", "text", "method"], "\u9A8C\u6536\u6761\u4EF6");
    require2(id(r.id) && !ids.has(r.id) && text(r.text, 500) && ["simulation", "review", "hardware"].includes(r.method), "\u9A8C\u6536\u6761\u4EF6\u7F16\u53F7\u3001\u6587\u5B57\u6216\u9A8C\u8BC1\u65B9\u5F0F\u65E0\u6548");
    ids.add(r.id);
    return { id: r.id, text: r.text.trim(), method: r.method };
  });
  require2(Array.isArray(value.scenarios) && value.scenarios.length <= AI_BEHAVIOR_LIMITS.scenarios, "\u6D4B\u8BD5\u573A\u666F\u6700\u591A6\u9879");
  const scenarioIds = /* @__PURE__ */ new Set(), assertionIds = /* @__PURE__ */ new Set(), covered = /* @__PURE__ */ new Set();
  let duration = 0, inputs = 0;
  const scenarios = value.scenarios.map((s) => {
    shape(s, ["id", "name", "durationMs", "inputs", "assertions"], "\u6D4B\u8BD5\u573A\u666F");
    require2(id(s.id) && !scenarioIds.has(s.id) && text(s.name, 160), "\u6D4B\u8BD5\u573A\u666F\u7F16\u53F7\u6216\u540D\u79F0\u65E0\u6548");
    scenarioIds.add(s.id);
    require2(integer(s.durationMs, 1, AI_BEHAVIOR_LIMITS.perScenarioMs), "\u5355\u4E2A\u573A\u666F\u9700\u89811\u20135000\u6BEB\u79D2");
    duration += s.durationMs;
    require2(Array.isArray(s.inputs) && (inputs += s.inputs.length) <= AI_BEHAVIOR_LIMITS.inputs, "\u6D4B\u8BD5\u8F93\u5165\u8D85\u8FC7256\u9879");
    const driven = /* @__PURE__ */ new Set();
    const stimuli = s.inputs.map((i) => {
      shape(i, ["atMs", "pin", "value"], "\u6D4B\u8BD5\u8F93\u5165");
      require2(integer(i.atMs, 0, s.durationMs), "\u8F93\u5165\u65F6\u95F4\u8D85\u51FA\u573A\u666F");
      require2(typeof i.pin === "string" && /^(D(?:[0-9]|1[0-3])|A[0-5])$/.test(i.pin), "\u8F93\u5165\u5F15\u811A\u53EA\u652F\u6301D0\u2013D13\u3001A0\u2013A5");
      require2(integer(i.value, 0, i.pin.startsWith("A") ? 1023 : 1), "\u6570\u5B57\u8F93\u5165\u503C\u4E3A0/1\uFF1B\u6A21\u62DF\u8F93\u5165\u4E3A0\u20131023");
      const key = `${i.atMs}:${i.pin}`;
      require2(!driven.has(key), "\u540C\u4E00\u65F6\u95F4\u4E0D\u80FD\u91CD\u590D\u8BBE\u7F6E\u540C\u4E00\u8F93\u5165");
      driven.add(key);
      return { atMs: i.atMs, pin: i.pin, value: i.value };
    }).sort((a, b) => a.atMs - b.atMs);
    require2(Array.isArray(s.assertions) && s.assertions.length > 0, "\u6BCF\u4E2A\u573A\u666F\u5FC5\u987B\u6709\u65AD\u8A00");
    const assertions = s.assertions.map((a) => {
      const keys = a?.kind === "pin" ? ["atMs", "pin", "value"] : a?.kind === "edges" ? ["fromMs", "toMs", "pin", "min", "max"] : ["fromMs", "toMs", "contains"];
      shape(a, ["id", "requirement", "kind", ...keys], "\u6D4B\u8BD5\u65AD\u8A00");
      require2(id(a.id) && !assertionIds.has(a.id) && requirements.some((r) => r.id === a.requirement && r.method === "simulation"), "\u65AD\u8A00\u9700\u8981\u552F\u4E00\u7F16\u53F7\u5E76\u5173\u8054simulation\u9A8C\u6536\u6761\u4EF6");
      assertionIds.add(a.id);
      covered.add(a.requirement);
      if (a.kind === "pin") {
        require2(integer(a.atMs, 1, s.durationMs) && integer(a.value, 0, 1), "\u5F15\u811A\u65AD\u8A00\u65F6\u95F4\u6216\u7535\u5E73\u65E0\u6548");
      } else {
        require2(integer(a.fromMs, 0, s.durationMs - 1) && integer(a.toMs, a.fromMs + 1, s.durationMs), "\u65AD\u8A00\u65F6\u95F4\u7A97\u53E3\u65E0\u6548");
        if (a.kind === "edges") require2(integer(a.min, 0, 1e4) && integer(a.max, a.min, 1e4), "\u53D8\u5316\u6B21\u6570\u5E94\u4E3A0\u201310000\uFF0Cmax\u4E0D\u5F97\u5C0F\u4E8Emin\uFF1B\u4FDD\u6301\u4E0D\u53D8\u53EF\u7528min=0,max=0");
        else require2(a.kind === "serial" && text(a.contains, 256), "\u4E32\u53E3\u65AD\u8A00\u9700\u8981\u975E\u7A7Acontains\u6587\u5B57");
      }
      if (a.kind !== "serial") {
        require2(typeof a.pin === "string" && /^D(?:[0-9]|1[0-3])$/.test(a.pin), "\u8F93\u51FA\u65AD\u8A00\u53EA\u652F\u6301D0\u2013D13");
        require2(!stimuli.some((i) => i.pin === a.pin), "\u4E0D\u5F97\u5BF9\u5916\u90E8\u8F93\u5165\u5F15\u811A\u65AD\u8A00\u8F93\u51FA\u6210\u529F");
      }
      return structuredClone(a);
    });
    return { id: s.id, name: s.name.trim(), durationMs: s.durationMs, inputs: stimuli, assertions };
  });
  require2(duration <= AI_BEHAVIOR_LIMITS.totalMs && assertionIds.size <= AI_BEHAVIOR_LIMITS.assertions, "\u6D4B\u8BD5\u603B\u65F6\u957F\u6216\u65AD\u8A00\u8D85\u8FC7\u9884\u7B97");
  require2(requirements.every((r) => r.method !== "simulation" || covered.has(r.id)), "\u6BCF\u9879\u6A21\u62DF\u9A8C\u6536\u6761\u4EF6\u81F3\u5C11\u5173\u8054\u4E00\u4E2A\u771F\u5B9E\u65AD\u8A00");
  const externalPins = [...new Set(scenarios.flatMap((s) => s.inputs.map((i) => i.pin)))];
  for (const scenario of scenarios) {
    const missing = externalPins.filter((pin) => !scenario.inputs.some((i) => i.pin === pin && i.atMs === 0));
    require2(!missing.length, `\u9A8C\u6536\u5C1A\u672A\u9501\u5B9A\uFF1A\u573A\u666F${scenario.id}\u7F3A\u5C11\u5916\u90E8\u8F93\u5165${missing.join("\u3001")}\u57280ms\u7684\u660E\u786E\u521D\u503C\u3002\u540C\u4E00\u56FA\u4EF6\u6BCF\u4E2A\u573A\u666F\u90FD\u987B\u521D\u59CB\u5316\u672C\u8BA1\u5212\u58F0\u660E\u7684\u6240\u6709\u5916\u90E8\u8F93\u5165\uFF0C\u4E0D\u80FD\u731C\u9ED8\u8BA4\u7535\u5E73\uFF1B\u8BF7\u8865\u9F50\u540E\u91CD\u65B0\u63D0\u4EA4\u5B8C\u6574\u8BA1\u5212\u3002`);
  }
  return { version: 1, requirements, scenarios };
}
var aiAcceptanceHash = (contract) => sha256Hex(JSON.stringify(parseAiAcceptance(contract)));

// desktop/apps/desktop/src/services/ai_avr_simulator.ts
function parseAiHex(hex) {
  if (hex.length > 2e5) throw Error("HEX\u8D85\u8FC7ATmega328P\u5BB9\u91CF");
  const bytes = new Uint8Array(32768).fill(255), written = /* @__PURE__ */ new Set();
  let base = 0, end = false;
  for (const line of hex.trim().split(/\r?\n/)) {
    if (end || !/^:[0-9A-Fa-f]+$/.test(line) || line.length % 2 !== 1) throw Error("HEX\u8BB0\u5F55\u683C\u5F0F\u65E0\u6548");
    const data = Uint8Array.from(line.slice(1).match(/../g), (v) => parseInt(v, 16));
    if (data.length !== data[0] + 5 || data.reduce((a, b) => a + b, 0) & 255) throw Error("HEX\u8BB0\u5F55\u957F\u5EA6\u6216\u6821\u9A8C\u548C\u65E0\u6548");
    const addr = data[1] * 256 + data[2], type = data[3], count = data[0];
    if (type === 0) {
      if (base + addr + count > bytes.length) throw Error("HEX\u8D85\u51FAATmega328P\u7A0B\u5E8F\u7A7A\u95F4");
      for (let i = 0; i < count; i++) {
        const at = base + addr + i;
        if (written.has(at)) throw Error("HEX\u5B58\u5728\u91CD\u53E0\u8BB0\u5F55");
        bytes[at] = data[4 + i];
        written.add(at);
      }
    } else if (type === 1 && count === 0 && addr === 0) end = true;
    else if ((type === 2 || type === 4) && count === 2 && addr === 0) base = (data[4] * 256 + data[5]) * (type === 2 ? 16 : 65536);
    else if (type === 3 || type === 5) throw Error("\u4E0D\u652F\u6301\u6539\u53D8\u542F\u52A8\u5730\u5740\u7684HEX");
    else throw Error("HEX\u8BB0\u5F55\u7C7B\u578B\u65E0\u6548");
  }
  if (!end || !written.has(0) || !written.has(1)) throw Error("HEX\u7F3A\u5C11\u590D\u4F4D\u5411\u91CF\u6216\u7ED3\u675F\u8BB0\u5F55");
  const words = new Uint16Array(16384);
  for (let i = 0; i < words.length; i++) words[i] = bytes[i * 2] | bytes[i * 2 + 1] << 8;
  return words;
}
function simulateAiFirmware(firmware, value, progress = () => {
}) {
  const contract = parseAiAcceptance(value), started = performance.now();
  const checks = [];
  const result = (status, reason) => ({
    status,
    contractSha256: aiAcceptanceHash(contract),
    sourceSha256: firmware.sourceSha256,
    firmwareSha256: firmware.sha256,
    fqbn: firmware.fqbn,
    elapsedMs: Math.round(performance.now() - started),
    checks,
    ...reason ? { reason } : {},
    engine: "avr8js-0.21.1",
    hardware: false
  });
  if (!aiSimulationTarget(firmware.fqbn)) return result("unsupported", "\u5F53\u524D\u4EC5\u63D0\u4F9B16MHz ATmega328P Uno/Nano\u6307\u4EE4\u6A21\u62DF");
  if (firmware.format !== "ihex" || sha256Hex(firmware.content) !== firmware.sha256) throw Error("\u6A21\u62DF\u56FA\u4EF6\u5185\u5BB9\u8BC1\u660E\u4E0D\u4E00\u81F4");
  const program = parseAiHex(firmware.content);
  if (!contract.scenarios.length) return result("unsupported", "\u672C\u6B21\u6CA1\u6709\u53EF\u6267\u884C\u7684\u6A21\u62DF\u65AD\u8A00");
  try {
    for (const scenario of contract.scenarios) {
      progress(scenario.name);
      const cpu = new import_avr8js.CPU(program.slice(), 2048);
      const ports = { B: new import_avr8js.AVRIOPort(cpu, import_avr8js.portBConfig), C: new import_avr8js.AVRIOPort(cpu, import_avr8js.portCConfig), D: new import_avr8js.AVRIOPort(cpu, import_avr8js.portDConfig) };
      new import_avr8js.AVRTimer(cpu, import_avr8js.timer0Config);
      new import_avr8js.AVRTimer(cpu, import_avr8js.timer1Config);
      new import_avr8js.AVRTimer(cpu, import_avr8js.timer2Config);
      const serial = new import_avr8js.AVRUSART(cpu, import_avr8js.usart0Config, 16e6), adc = new import_avr8js.AVRADC(cpu, import_avr8js.adcConfig);
      const analog = /* @__PURE__ */ new Map();
      const pin = (name) => {
        const n = Number(name.slice(1));
        return name.startsWith("A") ? { port: ports.C, bit: n } : n < 8 ? { port: ports.D, bit: n } : { port: ports.B, bit: n - 8 };
      };
      const state = (name) => {
        const { port, bit } = pin(name);
        return port.pinState(bit);
      };
      const transcript = [];
      serial.onByteTransmit = (byte) => {
        if (!(cpu.data[import_avr8js.usart0Config.UCSRB] & 8) || serial.bitsPerChar !== 8 || cpu.data[import_avr8js.usart0Config.UCSRC] & 192) throw Error("\u4E32\u53E3\u672A\u542F\u75288\u4F4D\u5F02\u6B65\u53D1\u9001\uFF0C\u65E0\u6CD5\u9A8C\u8BC1\u8F93\u51FA");
        if (transcript.length >= 32768) throw Error("\u4E32\u53E3\u8F93\u51FA\u8D85\u51FA\u6A21\u62DF\u8BB0\u5F55\u9884\u7B97");
        transcript.push({ at: cpu.cycles / 16e3, byte });
      };
      for (const [addr, mask, name] of [[76, 64, "SPI"], [188, 4, "I\xB2C"], [63, 7, "EEPROM"], [96, 72, "\u770B\u95E8\u72D7"], [80, 8, "\u6A21\u62DF\u6BD4\u8F83\u5668"], [97, 15, "\u53D8\u9891\u65F6\u949F"], [61, 3, "\u5916\u90E8\u4E2D\u65AD"], [104, 7, "\u5F15\u811A\u53D8\u5316\u4E2D\u65AD"]]) {
        cpu.writeHooks[addr] = (value2) => {
          if (value2 & mask) throw Error(`\u7A0B\u5E8F\u542F\u7528\u4E86\u5C1A\u672A\u6A21\u62DF\u7684${name}`);
          return false;
        };
      }
      adc.onADCRead = (input) => {
        if (input.type !== import_avr8js.ADCMuxInputType.SingleEnded || adc.referenceVoltageType !== import_avr8js.ADCReference.AVCC || !analog.has(input.channel)) throw Error("\u6A21\u62DF\u8F93\u5165\u6216\u53C2\u8003\u7535\u538B\u672A\u5728\u6D4B\u8BD5\u4E2D\u5B9A\u4E49");
        const sample = analog.get(input.channel);
        cpu.addClockEvent(() => adc.completeADCRead(sample), adc.sampleCycles);
      };
      const tracked = [...new Set(scenario.assertions.filter((a) => a.kind === "edges").map((a) => a.pin))];
      const transitions = new Map(tracked.map((name) => [name, []]));
      const previous = new Map(tracked.map((name) => [name, state(name)]));
      const modes = new Map(tracked.map((name) => [name, [{ at: 0, value: state(name) }]]));
      const observe = () => {
        for (const name of tracked) {
          const now = state(name), before = previous.get(name);
          if (now <= import_avr8js.PinState.High && before <= import_avr8js.PinState.High && now !== before) {
            const rows = transitions.get(name);
            if (rows.length > 2e4) throw Error("\u5F15\u811A\u53D8\u5316\u8D85\u8FC7\u8BB0\u5F55\u9884\u7B97");
            rows.push(cpu.cycles / 16e3);
          }
          if (now !== before) {
            const rows = modes.get(name);
            if (rows.length >= 2e4) throw Error("\u5F15\u811A\u6A21\u5F0F\u53D8\u5316\u8D85\u8FC7\u8BB0\u5F55\u9884\u7B97");
            rows.push({ at: cpu.cycles / 16e3, value: now });
          }
          previous.set(name, now);
        }
      };
      ports.B.addListener(observe);
      ports.D.addListener(observe);
      const sampleChecks = /* @__PURE__ */ new Map();
      const scheduled = [];
      for (const input of scenario.inputs) scheduled.push({ cycle: input.atMs * 16e3, order: 0, run: () => {
        if (input.pin.startsWith("A")) analog.set(Number(input.pin.slice(1)), input.value);
        else {
          const p = pin(input.pin);
          p.port.setPin(p.bit, Boolean(input.value));
        }
      } });
      for (const a of scenario.assertions) if (a.kind === "pin") scheduled.push({ cycle: a.atMs * 16e3, order: 1, run: () => sampleChecks.set(a.id, state(a.pin)) });
      scheduled.sort((a, b) => a.cycle - b.cycle || a.order - b.order);
      let cursor = 0, iterations = 0;
      const endCycle = scenario.durationMs * 16e3;
      while (cpu.cycles < endCycle) {
        while (cursor < scheduled.length && scheduled[cursor].cycle <= cpu.cycles) scheduled[cursor++].run();
        if (cpu.pc >= program.length || cpu.SP < 256 || cpu.SP >= cpu.data.length) throw Error("\u7A0B\u5E8F\u8BA1\u6570\u5668\u6216\u6808\u8D85\u51FAATmega328P\u7A7A\u95F4");
        (0, import_avr8js.avrInstruction)(cpu);
        cpu.tick();
        if ((++iterations & 16383) === 0 && performance.now() - started > AI_BEHAVIOR_LIMITS.wallMs) throw Error("\u6307\u4EE4\u6A21\u62DF\u8FBE\u5230\u65F6\u95F4\u9884\u7B97");
      }
      while (cursor < scheduled.length && scheduled[cursor].cycle <= cpu.cycles) scheduled[cursor++].run();
      for (const a of scenario.assertions) {
        let actual, expected, ok;
        if (a.kind === "pin") {
          const v = sampleChecks.get(a.id);
          actual = v === 0 || v === 1 ? String(v) : "\u672A\u8BBE\u7F6E\u4E3A\u8F93\u51FA";
          expected = `${a.pin}\u5728${a.atMs}ms\u8F93\u51FA${a.value}`;
          ok = v === a.value;
        } else if (a.kind === "edges") {
          const count = transitions.get(a.pin).filter((t) => t >= a.fromMs && t <= a.toMs).length;
          const modesInWindow = modes.get(a.pin);
          const initial = modesInWindow.reduce((last, m) => m.at <= a.fromMs ? m : last, modesInWindow[0]);
          const outputThroughout = initial.value <= import_avr8js.PinState.High && modesInWindow.filter((m) => m.at > a.fromMs && m.at <= a.toMs).every((m) => m.value <= import_avr8js.PinState.High);
          actual = outputThroughout ? `${count}\u6B21` : "\u7A97\u53E3\u5185\u672A\u59CB\u7EC8\u8BBE\u7F6E\u4E3A\u8F93\u51FA";
          expected = `${a.pin}\u5728${a.fromMs}\u2013${a.toMs}ms\u53D8\u5316${a.min}\u2013${a.max}\u6B21`;
          ok = outputThroughout && count >= a.min && count <= a.max;
        } else {
          const content = new TextDecoder().decode(Uint8Array.from(transcript.filter((t) => t.at >= a.fromMs && t.at <= a.toMs), (t) => t.byte));
          expected = `\u4E32\u53E3\u5728${a.fromMs}\u2013${a.toMs}ms\u5305\u542B${JSON.stringify(a.contains)}`;
          actual = content.slice(-800) || "(\u65E0\u8F93\u51FA)";
          ok = content.includes(a.contains);
        }
        checks.push({ scenario: scenario.id, id: a.id, requirement: a.requirement, ok, expected, actual });
      }
    }
    return result(checks.every((c) => c.ok) ? "passed" : "failed");
  } catch (error) {
    return result("unsupported", error instanceof Error ? error.message : String(error));
  }
}
export {
  parseAiHex,
  simulateAiFirmware
};
