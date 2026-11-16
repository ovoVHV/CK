import type { BoardResourceGraph, HardwareResource, ResourceRoute } from './hardware_resource_graph';
import { validateResourceGraph } from './resource_contract';

/**
 * Shared graph-construction primitives used by board-family resource models.
 *
 * The builder owns only graph shape and route construction.  Hardware facts,
 * aliases, capabilities and evidence remain in the selected board/model
 * definition.  Keeping this layer data-agnostic prevents a model provider
 * from quietly growing a board-specific analyzer or conflict path.
 */
export interface ResourceGraphBuilder {
  resources: HardwareResource[];
  routes: ResourceRoute[];
  add(
    id: string,
    type: string,
    sharing: HardwareResource['sharing'],
    detail?: Partial<HardwareResource>,
  ): HardwareResource;
  fixedRoute(resource: string, signal: string, pin: number | string): ResourceRoute;
  selectableRoute(resource: string, signal: string, pins: readonly (number | string)[]): ResourceRoute;
  build(evidence: BoardResourceGraph['evidence'], coverage?: BoardResourceGraph['coverage']): BoardResourceGraph;
}

export function createResourceGraphBuilder(defaultEvidence: readonly string[] = []): ResourceGraphBuilder {
  const resources: HardwareResource[] = [];
  const routes: ResourceRoute[] = [];
  const add = (
    id: string,
    type: string,
    sharing: HardwareResource['sharing'],
    detail: Partial<HardwareResource> = {},
  ): HardwareResource => {
    const resource: HardwareResource = {
      id,
      type,
      sharing,
      evidence: [...defaultEvidence],
      ...detail,
    };
    resources.push(resource);
    return resource;
  };
  const fixedRoute = (resource: string, signal: string, pin: number | string): ResourceRoute => {
    const route: ResourceRoute = {
      id: `${resource}.${signal}`,
      resource,
      signal,
      mode: 'fixed',
      pins: [`gpio.${pin}`],
    };
    routes.push(route);
    return route;
  };
  const selectableRoute = (
    resource: string,
    signal: string,
    pins: readonly (number | string)[],
  ): ResourceRoute => {
    const route: ResourceRoute = {
      id: `${resource}.${signal}`,
      resource,
      signal,
      mode: 'selectable',
      pins: pins.map(pin => `gpio.${pin}`),
    };
    routes.push(route);
    return route;
  };
  const build = (
    evidence: BoardResourceGraph['evidence'],
    coverage: BoardResourceGraph['coverage'] = 'full',
  ): BoardResourceGraph => validateResourceGraph({
    version: 1,
    coverage,
    resources,
    routes,
    evidence,
  });

  return { resources, routes, add, fixedRoute, selectableRoute, build };
}
