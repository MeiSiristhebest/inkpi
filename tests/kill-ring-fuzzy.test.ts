import { describe, it, expect } from 'vitest';
import { KillRing, fuzzySearch } from '@inkpi/agent-core';

describe('@inkpi/agent-core -> Kill-Ring & Fuzzy Search (1:1 Ported from repos/pi/tui)', () => {
  it('should push, yank, and cycle through deleted text snippets in KillRing', () => {
    const kr = new KillRing(5);

    kr.push('灵感段落 1: 主角获得神秘铜镜');
    kr.push('灵感段落 2: 宗门大比突然遭遇兽潮');
    kr.push('灵感段落 3: 丹炉异变炼出绝品天丹');

    expect(kr.size()).toBe(3);
    // Yank latest
    expect(kr.peek()).toBe('灵感段落 3: 丹炉异变炼出绝品天丹');

    // Yank-Pop / Rotate
    expect(kr.rotate()).toBe('灵感段落 2: 宗门大比突然遭遇兽潮');
    expect(kr.rotate()).toBe('灵感段落 1: 主角获得神秘铜镜');
    expect(kr.rotate()).toBe('灵感段落 3: 丹炉异变炼出绝品天丹'); // wrap-around cycle

    kr.clear();
    expect(kr.size()).toBe(0);
    expect(kr.peek()).toBeUndefined();
  });

  it('should perform fuzzy subsequence matching with word boundary and consecutive bonuses', () => {
    const documents = [
      { id: '1', title: '第一folder 第十document 绝境逢生' },
      { id: '2', title: '第一folder 第十一document 生死时速' },
      { id: '3', title: '第二folder 第一document 破茧成蝶' },
      { id: '4', title: '第二folder 第二document 蝶变与宿命' }
    ];

    const results = fuzzySearch('绝境', documents, (c) => c.title);
    expect(results.length).toBe(1);
    expect(results[0].item.title).toBe('第一folder 第十document 绝境逢生');

    const butterflyResults = fuzzySearch('蝶', documents, (c) => c.title);
    expect(butterflyResults.length).toBe(2);
  });
});
