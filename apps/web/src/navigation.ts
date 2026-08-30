export const MAIN_NAVIGATION = [
  { id: 'browse', label: '档案' },
  { id: 'data', label: '数据' },
  { id: 'trends', label: '趋势' },
  { id: 'account', label: '账户' },
] as const;

export type MainTab = (typeof MAIN_NAVIGATION)[number]['id'];
