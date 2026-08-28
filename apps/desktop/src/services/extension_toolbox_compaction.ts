const EXTENSION_TOOLBOX_GROUP_NAME = '扩展库';
const EXTENSION_TOOLBOX_GROUP_COLOUR = '#0F766E';

/**
 * Keep third-party categories behind one top-level entry. Each package keeps
 * its own nested category and colour, while the main rail stays usable with
 * dozens of installed libraries. Global block search remains unchanged.
 */
export const compactExtensionToolboxXml = (extensionXml: string): string => {
    const fragment = String(extensionXml || '').trim();
    if (!fragment) return '';
    return [
        `<category name="${EXTENSION_TOOLBOX_GROUP_NAME}" colour="${EXTENSION_TOOLBOX_GROUP_COLOUR}" expanded="false">`,
        fragment,
        '</category>',
    ].join('\n');
};

