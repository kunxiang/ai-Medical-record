import { describe, expect, it } from 'vitest';
import { parseObservationPaste } from './ObservationWorkbench.js';

describe('Observation workbench paste parser', () => {
  it('parses a Chinese TSV header and keeps report values verbatim', () => {
    const rows = parseObservationPaste(
      '项目\t结果\t单位\t参考范围\t标记\n肌酐\t<88.4\tumol/L\t41-81\t↑',
      2,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      local_name: '肌酐', value_raw: '<88.4', unit_raw: 'umol/L',
      ref_low: '41', ref_high: '81', abnormal_flag_raw: '↑', source_page_no: 2,
    });
  });

  it('parses quoted CSV and preserves commas inside cells', () => {
    const rows = parseObservationPaste('item,result,unit,reference\n"白细胞,总数",5.6,10^9/L,"3.5-9.5"', null);
    expect(rows[0]).toMatchObject({
      local_name: '白细胞,总数', value_raw: '5.6', unit_raw: '10^9/L',
      ref_low: '3.5', ref_high: '9.5', source_page_no: null,
    });
  });
});
