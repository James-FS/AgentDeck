import type { Catalog } from '@agentdeck/contracts';

export function scanNotice(catalog: Catalog | null): { type: 'success' | 'warning' | 'error'; message: string } {
  const outcome = catalog?.lastScan;
  if (!outcome || outcome.status === 'succeeded') {
    return { type: 'success', message: `只读扫描完成，索引共 ${catalog?.bindings.length ?? 0} 项资源` };
  }
  const sources = outcome.failures.map(failure => {
    const instance = catalog?.instances.find(item => item.id === failure.instanceId);
    const project = catalog?.projects.find(item => item.id === failure.projectId);
    return `${instance?.name ?? failure.agentId}${project ? ` / ${project.name}` : ''}：${failure.message}`;
  });
  return {
    type: outcome.status === 'partial' ? 'warning' : 'error',
    message: `${outcome.status === 'partial' ? '扫描部分失败' : '扫描失败'}；${sources.join('；')}`,
  };
}
