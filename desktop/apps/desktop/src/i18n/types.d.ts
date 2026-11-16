import 'i18next';
import type zhCNCommon from '../locales/zh-CN/common.json';
import type zhCNLibraries from '../locales/zh-CN/libraries.json';
import type zhCNSerial from '../locales/zh-CN/serial.json';
import type zhCNBuild from '../locales/zh-CN/build.json';
import type zhCNHealth from '../locales/zh-CN/health.json';
import type zhCNRecovery from '../locales/zh-CN/recovery.json';
import type zhCNEditor from '../locales/zh-CN/editor.json';

declare module 'i18next' {
    interface CustomTypeOptions {
        defaultNS: 'common';
        returnNull: false;
        resources: {
            common: typeof zhCNCommon;
            libraries: typeof zhCNLibraries;
            serial: typeof zhCNSerial;
            build: typeof zhCNBuild;
            health: typeof zhCNHealth;
            recovery: typeof zhCNRecovery;
            editor: typeof zhCNEditor;
        };
    }
}
