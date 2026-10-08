import { Box, Clock, Connection, Folder, House } from '@element-plus/icons-vue';

export type Page = 'overview' | 'resources' | 'instances' | 'projects' | 'operations';

export const pages = [
  { id: 'overview' as const, label: '总览', icon: House },
  { id: 'resources' as const, label: '资源管理', icon: Box },
  { id: 'instances' as const, label: 'Agent 实例', icon: Connection },
  { id: 'projects' as const, label: '项目空间', icon: Folder },
  { id: 'operations' as const, label: '操作记录', icon: Clock },
];
