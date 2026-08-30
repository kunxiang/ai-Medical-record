import { describe, expect, it } from 'vitest';
import { MAIN_NAVIGATION } from './navigation.js';

describe('P0 information architecture', () => {
  it('主导航固定四项，采集不占用平级入口', () => {
    expect(MAIN_NAVIGATION.map((item) => item.label)).toEqual(['档案', '数据', '趋势', '账户']);
    expect(MAIN_NAVIGATION.some((item) => (item.id as string) === 'capture')).toBe(false);
  });
});
