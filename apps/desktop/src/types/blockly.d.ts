import 'blockly';

declare module 'blockly' {
    interface Generator {
        [key: string]: any;
    }
}
