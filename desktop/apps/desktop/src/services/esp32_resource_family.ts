import {
  resolveEsp32ResourceModel,
  type Esp32ResolvedIdentity,
} from './esp32_resource_model';
import { resolveEsp32C3ResourceModel } from './esp32_c3_resource_model';
import { resolveEsp32C6ResourceModel } from './esp32_c6_resource_model';
import { resolveEsp32S3ResourceModel } from './esp32_s3_resource_model';

export type { Esp32ResolvedIdentity } from './esp32_resource_model';

/**
 * Stable presentation-independent metadata consumed by the first-party
 * hardware-claim adapter.  The adapter must not know board display names or
 * copy per-board defaults: those belong to the resolved resource model.
 *
 * C3 (and future ESP32-family models) can be added to the resolver without
 * creating another analyzer.  The model selected here is always selected by
 * the compiler-resolved identity.
 */
export interface Esp32SerialDefault {
  /** Resource id in the selected BoardResourceGraph. */
  resource: string;
  /** Optional signal defaults. USB Serial/JTAG has no UART pin routes. */
  rx?: string;
  tx?: string;
  transport?: 'uart' | 'usb-serial-jtag' | 'usb-otg';
}

export interface Esp32ResourceModelMetadata {
  serialDefaults: Record<string, Esp32SerialDefault>;
  /** Resource used by Arduino's `Serial` alias, when the model exposes one. */
  defaultSerial?: string;
}

export type Esp32ResourceModel = {
  status: 'ready';
  identity: Esp32ResolvedIdentity;
  resource_graph: import('./hardware_resource_graph').BoardResourceGraph;
  metadata?: Esp32ResourceModelMetadata;
  serialDefaults?: Record<string, Esp32SerialDefault>;
  [key: string]: unknown;
} | {
  status: 'not-applicable';
  reason: string;
};

/**
 * Resolve the ESP32-family model from the already observed compiler
 * properties.  This is deliberately a family resolver, not a board-name or
 * analyzer dispatch branch.  New models (for example ESP32-C3) should be
 * registered here by identity predicates and return the same model contract.
 */
export function resolveEsp32FamilyResourceModel(identity: Esp32ResolvedIdentity): Esp32ResourceModel {
  const boardId = identity.fqbn.split(':')[2];
  if ((boardId === 'esp32s3' || boardId === 'esp32s3-octal')
    && identity.mcu === 'esp32s3' && identity.variant === 'esp32s3') {
    return resolveEsp32S3ResourceModel(identity) as Esp32ResourceModel;
  }
  if (identity.fqbn.split(':').slice(0, 3).join(':') === 'esp32:esp32:esp32c3'
    && identity.mcu === 'esp32c3' && identity.variant === 'esp32c3') {
    return resolveEsp32C3ResourceModel(identity) as Esp32ResourceModel;
  }
  if (identity.fqbn.split(':').slice(0, 3).join(':') === 'esp32:esp32:esp32c6'
    && identity.mcu === 'esp32c6' && identity.variant === 'esp32c6') {
    return resolveEsp32C6ResourceModel(identity) as Esp32ResourceModel;
  }
  return resolveEsp32ResourceModel(identity) as Esp32ResourceModel;
}
