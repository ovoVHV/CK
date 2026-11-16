import enUSCommon from '../locales/en-US/common.json';
import zhCNCommon from '../locales/zh-CN/common.json';
import enUSLibraries from '../locales/en-US/libraries.json';
import zhCNLibraries from '../locales/zh-CN/libraries.json';
import enUSSerial from '../locales/en-US/serial.json';
import zhCNSerial from '../locales/zh-CN/serial.json';
import enUSBuild from '../locales/en-US/build.json';
import zhCNBuild from '../locales/zh-CN/build.json';
import enUSHealth from '../locales/en-US/health.json';
import zhCNHealth from '../locales/zh-CN/health.json';
import enUSRecovery from '../locales/en-US/recovery.json';
import zhCNRecovery from '../locales/zh-CN/recovery.json';
import enUSEditor from '../locales/en-US/editor.json';
import zhCNEditor from '../locales/zh-CN/editor.json';

export const I18N_NAMESPACES = ['common', 'libraries', 'serial', 'build', 'health', 'recovery', 'editor'] as const;
export type I18nNamespace = (typeof I18N_NAMESPACES)[number];

export const resources = {
    'zh-CN': {
        common: zhCNCommon,
        libraries: zhCNLibraries,
        serial: zhCNSerial,
        build: zhCNBuild,
        health: zhCNHealth,
        recovery: zhCNRecovery,
        editor: zhCNEditor,
    },
    'en-US': {
        common: enUSCommon,
        libraries: enUSLibraries,
        serial: enUSSerial,
        build: enUSBuild,
        health: enUSHealth,
        recovery: enUSRecovery,
        editor: enUSEditor,
    },
} as const;
