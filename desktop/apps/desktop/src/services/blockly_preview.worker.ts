// Preview only. Compile/upload always regenerate on the authoritative workspace.
import * as Blockly from 'blockly';
import {setBlocklyBoard} from '../components/blockly_setup';
import {arduinoGenerator} from '../components/arduino_generator';
import './block_breakpoints';
import {applyBlocklyLocale} from './blockly_locale';

const canonical = (value: any): string => JSON.stringify(value, (_key, item) => (
    item && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]]))
        : item
));
self.onmessage = (event: MessageEvent) => {
    const {id, serialized, fqbn, locale} = event.data;
    const workspace = new Blockly.Workspace();
    try {
        const state = JSON.parse(serialized);
        setBlocklyBoard(fqbn);
        applyBlocklyLocale(locale);
        Blockly.Events.disable();
        Blockly.serialization.workspaces.load(state, workspace);
        // Reject missing serializers, unknown fields, mutator differences and
        // board dropdown coercion. Never publish an approximate preview.
        if (canonical(Blockly.serialization.workspaces.save(workspace)) !== canonical(state)) {
            self.postMessage({id, code:null, reason:'snapshot-roundtrip-mismatch'});
        } else {
            self.postMessage({id, code:arduinoGenerator.workspaceToCode(workspace)});
        }
    } catch (error) {
        self.postMessage({id, code:null, reason:String(error)});
    } finally {
        workspace.dispose();
        Blockly.Events.enable();
    }
};
