import type {ModuleRegistration, WorkbenchModule} from './contracts/module';
import {manifests} from './catalog';
/** Vite discovers factories mechanically; adding a manifest remains the only registration. */
const factories = import.meta.glob<{createModule(): WorkbenchModule}>('../modules/*/module.tsx');
export const catalog: ModuleRegistration[] = manifests.map(manifest => {
  const load = factories[`../modules/${manifest.id}/module.tsx`];
  if (!load) throw Error(`模块 ${manifest.id} 缺少页面工厂`);
  return {manifest, load: async () => (await load()).createModule()};
});
