import { simulateAiFirmware } from './ai_avr_simulator';
self.onmessage = event => {
    try { self.postMessage({ result: simulateAiFirmware(event.data.firmware, event.data.contract, name => self.postMessage({ progress: name })) }); }
    catch (error) { self.postMessage({ error: error instanceof Error ? error.message : String(error) }); }
};
