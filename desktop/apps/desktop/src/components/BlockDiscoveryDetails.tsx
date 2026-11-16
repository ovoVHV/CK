import { useTranslation } from 'react-i18next';
import type { BlockSearchEntry } from '../types/library';
import type { HardwareResourceInspectorView } from '../services/hardware_resource_inspector';
import { describeBlockDiscovery } from './block_discovery_presentation';

export function BlockDiscoveryDetails({ entry, view }: {
    entry: BlockSearchEntry; view?: HardwareResourceInspectorView | null;
}) {
    const { t } = useTranslation('editor');
    const detail = describeBlockDiscovery(entry, view);
    return <span className="ck-block-discovery-details" data-ck-role="block-discovery" data-context={detail.context}>
        <span><b>{t('discovery.requires')}: </b>{detail.resources.length
            ? detail.resources.map(kind => t(`discovery.kind.${kind}`)).join(' · ')
            : t('discovery.undeclared')}</span>
        {(detail.boards.length > 0 || detail.architectures.length > 0) && <span>
            <b>{t('discovery.declaredTargets')}: </b>{[...detail.boards, ...detail.architectures].join(' · ')}
        </span>}
        {detail.dependencies.length > 0 && <span><b>{t('discovery.dependencies')}: </b>{detail.dependencies.join(' · ')}</span>}
        {view && detail.resources.some(kind => kind === 'i2c' || kind === 'spi' || kind === 'uart') && <span>
            <b>{t('discovery.controllers')}: </b>{detail.controllers.length > 0 ? detail.controllers.join(' · ') : t('discovery.noController')}
        </span>}
        <span className="ck-block-discovery-note">{t(`discovery.context.${detail.context}`)}</span>
    </span>;
}
