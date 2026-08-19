import assert from 'node:assert/strict';
import JSZip from 'jszip';
import test from 'node:test';
import { createImportTemplate, parseImportPackage, parseMarkdown, type ContentNode } from './ingestion.js';

function collectNodes(nodes: ContentNode[]): ContentNode[] {
  const result: ContentNode[] = [];
  for (const node of nodes) {
    result.push(node);
    if (node.children) {
      result.push(...collectNodes(node.children));
    }
  }
  return result;
}

test('Markdown 解析保留四级层级、公式、表格和图片节点', () => {
  const result = parseMarkdown(
    [
      '# 学习资料',
      '## 第一章',
      '### 基础',
      '#### 闭包',
      '',
      '普通文本与 $x^2$。',
      '',
      '$$',
      'E = mc^2',
      '$$',
      '',
      '| 名称 | 值 |',
      '| --- | --- |',
      '| 速度 | 42 |',
      '',
      '![示例](assets/example.png)',
    ].join('\n'),
    { fileName: 'notes/study.md' },
  );

  assert.equal(result.issues.length, 0);
  assert.equal(result.document?.title, '学习资料');
  assert.equal(result.document?.chapters[0]?.sections[0]?.cards[0]?.title, '闭包');
  const nodes = collectNodes(result.document?.chapters[0]?.sections[0]?.cards[0]?.content ?? []);
  assert.ok(nodes.some((node) => node.type === 'inlineMath' && node.value === 'x^2'));
  assert.ok(nodes.some((node) => node.type === 'math' && node.value === 'E = mc^2'));
  assert.ok(nodes.some((node) => node.type === 'table'));
  assert.ok(nodes.some((node) => node.type === 'image' && node.resourcePath === 'notes/assets/example.png'));
  assert.equal(result.imageReferences[0]?.resourcePath, 'notes/assets/example.png');
});

test('Markdown 结构错误包含行号、上下文和修复建议', () => {
  const result = parseMarkdown(
    ['卡片外正文', '# 资料', '### 缺少章', '#### 闪卡', '正文'].join('\n'),
    { fileName: 'invalid.md' },
  );

  const unassigned = result.issues.find((item) => item.code === 'unassigned_content');
  const missingParent = result.issues.find((item) => item.code === 'missing_parent');
  assert.equal(unassigned?.location.line, 1);
  assert.equal(unassigned?.location.fileName, 'invalid.md');
  assert.match(unassigned?.suggestion ?? '', /####/);
  assert.equal(missingParent?.location.line, 3);
  assert.match(missingParent?.message ?? '', /缺少/);
  assert.ok(result.issues.length > 0);
});

test('Markdown 拒绝空标题、第五级标题、重复资料和原始 HTML', () => {
  const result = parseMarkdown(
    ['# 资料', '## 章', '### 节', '#### 卡', '<script>alert(1)</script>', '## ', '##### 不支持', '# 第二份'].join('\n'),
    { fileName: 'unsafe.md' },
  );

  assert.ok(result.issues.some((item) => item.code === 'empty_title'));
  assert.ok(result.issues.some((item) => item.code === 'unsupported_heading_level'));
  assert.ok(result.issues.some((item) => item.code === 'multiple_materials'));
  assert.ok(result.issues.some((item) => item.code === 'unsafe_html'));
});

test('Markdown 兼容 HTML 换行与表格', () => {
  const result = parseMarkdown(
    [
      '# 资料',
      '## 章',
      '### 节',
      '#### 卡',
      '',
      '<p>第一行<br>第二行</p>',
      '',
      '<table>',
      '<thead><tr><th>名称</th><th align="right">值</th></tr></thead>',
      '<tbody><tr><td>速度</td><td>42</td></tr></tbody>',
      '</table>',
    ].join('\n'),
    { fileName: 'html.md' },
  );

  const card = result.document?.chapters[0]?.sections[0]?.cards[0];
  const nodes = collectNodes(card?.content ?? []);
  assert.equal(result.issues.length, 0);
  assert.ok(nodes.some((node) => node.type === 'break'));
  const table = nodes.find((node) => node.type === 'table');
  assert.equal(table?.children?.length, 2);
  assert.equal(table?.children?.[0]?.header, true);
  assert.equal(table?.children?.[1]?.header, false);
  assert.equal(table?.children?.[0]?.children?.[1]?.align?.[0], 'right');
  assert.equal(table?.children?.[1]?.children?.[1]?.children?.[0]?.value, '42');
});

test('HTML 脚本和事件属性继续被阻止', () => {
  const result = parseMarkdown(
    '# 资料\n## 章\n### 节\n#### 卡\n<div onclick="alert(1)">正文</div>',
    { fileName: 'unsafe-html.md' },
  );

  assert.ok(result.issues.some((item) => item.code === 'unsafe_html'));
});

test('公式语法错误带有精确位置，疑似表格文本按普通正文保留', () => {
  const result = parseMarkdown(
    [
      '# 资料',
      '## 章',
      '### 节',
      '#### 卡',
      '错误公式：$\\frac{1$',
      '',
      '| 名称 | 值 |',
      '| --- | nope |',
      '| 速度 | 42 |',
    ].join('\n'),
    { fileName: 'syntax.md' },
  );

  const formula = result.issues.find((item) => item.code === 'invalid_formula');
  assert.equal(formula?.location.line, 5);
  assert.match(formula?.suggestion ?? '', /LaTeX/);
  assert.equal(result.issues.some((item) => item.code === 'invalid_table'), false);
});

test('包含 -、:、| 的普通正文不会被误判为表格', () => {
  const result = parseMarkdown(
    [
      '# 资料',
      '## 章',
      '### 节',
      '#### 卡',
      '正文可以包含 - 连字符、: 冒号和 | 竖线。',
      '| 这不是表格 | --- 也不是分隔行 |',
      'A | B - C: D',
    ].join('\n'),
    { fileName: 'plain-text.md' },
  );

  assert.equal(result.issues.some((item) => item.code === 'invalid_table'), false);
  const card = result.document?.chapters[0]?.sections[0]?.cards[0];
  assert.match(JSON.stringify(card?.content), /连字符/);
  assert.match(JSON.stringify(card?.content), /不是分隔行/);
});

test('JSON body 中的疑似表格文本可以正常导入', async () => {
  const result = await parseImportPackage('many-tables.json', Buffer.from(JSON.stringify({
    format: 'knowledge-flashcards-material',
    version: 1,
    title: '表格资料',
    chapters: [{
      title: '第一章',
      sections: [{
        title: '第一节',
        cards: [{
          title: '目标闪卡',
          body: ['正文 | 可以包含竖线', '| --- | 这只是正文 |', '值 - 可以带连字符: 也可以带冒号'].join('\n'),
        }],
      }],
    }],
  })));

  assert.equal(result.valid, true);
  assert.equal(result.issues.some((item) => item.code === 'invalid_table'), false);
});

test('图片路径穿越会在图片所在行被阻止', () => {
  const result = parseMarkdown('# 资料\n## 章\n### 节\n#### 卡\n![图](../secret.png)', {
    fileName: 'notes/study.md',
  });

  const invalidImage = result.issues.find((item) => item.code === 'invalid_image_path');
  assert.equal(invalidImage?.location.line, 5);
  assert.match(invalidImage?.suggestion ?? '', /图片路径/);
});

test('ZIP 资料包解析相对资源并阻止路径穿越', async () => {
  const archive = new JSZip();
  archive.file('notes/study.md', '# 资料\n## 章\n### 节\n#### 卡\n![图](assets/chart.png)');
  archive.file('notes/assets/chart.png', Buffer.from([1, 2, 3]));
  archive.file('../outside.txt', '不应被读取');

  const result = await parseImportPackage('study.zip', await archive.generateAsync({ type: 'nodebuffer' }));
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((item) => item.code === 'archive_path_traversal'));
  assert.equal(result.markdownFileName, 'notes/study.md');
});

test('合法 ZIP 资料包会返回结构化正文和待应用资源', async () => {
  const archive = new JSZip();
  archive.file('study.md', '# 资料\n## 章\n### 节\n#### 卡\n![图](images/chart.png)');
  archive.file('images/chart.png', Buffer.from([9, 8, 7]));

  const result = await parseImportPackage('study.zip', await archive.generateAsync({ type: 'nodebuffer' }));
  assert.equal(result.valid, true);
  assert.equal(result.issues.length, 0);
  assert.equal(result.resources[0]?.relativePath, 'images/chart.png');
  assert.deepEqual([...result.resources[0]?.content ?? []], [9, 8, 7]);
  const cardNodes = collectNodes(result.document?.chapters[0]?.sections[0]?.cards[0]?.content ?? []);
  assert.ok(cardNodes.some((node) => node.type === 'image' && node.resourcePath === 'images/chart.png'));
});

test('ZIP 资料包缺少被引用图片时精确报告资源路径', async () => {
  const archive = new JSZip();
  archive.file('study.md', '# 资料\n## 章\n### 节\n#### 卡\n![图](missing.png)');

  const result = await parseImportPackage('study.zip', await archive.generateAsync({ type: 'nodebuffer' }));
  const missingImage = result.issues.find((item) => item.code === 'missing_image');
  assert.equal(result.valid, false);
  assert.equal(missingImage?.location.fileName, 'study.md');
  assert.match(missingImage?.message ?? '', /missing\.png/);
  assert.equal(missingImage?.context.at(-1), '卡');
});

test('内容级 JSON 会保留层级并使用 Markdown 解析正文', async () => {
  const source = Buffer.from(JSON.stringify({
    format: 'knowledge-flashcards-material',
    version: 1,
    title: 'JSON 资料',
    chapters: [{
      title: '第一章',
      sections: [{
        title: '第一节',
        cards: [{
          title: '第一张卡',
          body: '正文中的 **强调** 与 $x^2$。',
        }],
      }],
    }],
  }));

  const result = await parseImportPackage('lesson.json', source);
  const nodes = collectNodes(result.document?.chapters[0]?.sections[0]?.cards[0]?.content ?? []);
  assert.equal(result.sourceType, 'json');
  assert.equal(result.valid, true);
  assert.equal(result.document?.title, 'JSON 资料');
  assert.ok(nodes.some((node) => node.type === 'strong'));
  assert.ok(nodes.some((node) => node.type === 'inlineMath' && node.value === 'x^2'));
});

test('内容级 JSON 会按文本和公式自动生成高亮锚点', async () => {
  const source = Buffer.from(JSON.stringify({
    format: 'knowledge-flashcards-material',
    version: 1,
    title: '带标注资料',
    chapters: [{
      title: '第一章',
      sections: [{
        title: '第一节',
        cards: [{
          title: '第一张卡',
          body: '牛顿第二定律为 $F = ma$，力和加速度成正比。',
          highlights: [
            { text: '力和加速度成正比' },
            { formula: 'F = ma' },
          ],
        }],
      }],
    }],
  }));

  const result = await parseImportPackage('highlighted.json', source);
  const card = result.document?.chapters[0]?.sections[0]?.cards[0];
  assert.equal(result.valid, true);
  assert.equal(card?.highlights.length, 2);
  assert.deepEqual(card?.highlights[0], {
    kind: 'text',
    target: '力和加速度成正比',
    occurrence: undefined,
    anchor: { nodePath: '0.2', start: 1, end: 9 },
  });
  assert.deepEqual(card?.highlights[1], {
    kind: 'formula',
    target: 'F = ma',
    occurrence: undefined,
    anchor: { nodePath: '0.1' },
  });
});

test('body 内联标记会按标记位置高亮重复文本并从正文移除', async () => {
  const cleanBody = '第一类危险源决定事故后果；第二类危险源决定事故发生可能性。';
  const result = await parseImportPackage('inline-highlighted.json', Buffer.from(JSON.stringify({
    format: 'knowledge-flashcards-material',
    version: 1,
    title: '内联高亮资料',
    chapters: [{
      title: '章',
      sections: [{
        title: '节',
        cards: [{
          title: '卡',
          body: '第一类[[hl:危险源]]决定事故后果；第二类[[hl:危险源]]决定事故发生可能性。',
          highlights: [],
        }],
      }],
    }],
  })));
  const card = result.document?.chapters[0]?.sections[0]?.cards[0];
  const textNode = collectNodes(card?.content ?? []).find((node) => node.type === 'text');

  assert.equal(result.valid, true);
  assert.equal(textNode?.value, cleanBody);
  assert.equal(JSON.stringify(card?.content).includes('[[hl:'), false);
  assert.deepEqual(card?.highlights, [
    {
      kind: 'text',
      target: '危险源',
      occurrence: undefined,
      inline: true,
      anchor: { nodePath: '0.0', start: cleanBody.indexOf('危险源'), end: cleanBody.indexOf('危险源') + 3 },
    },
    {
      kind: 'text',
      target: '危险源',
      occurrence: undefined,
      inline: true,
      anchor: { nodePath: '0.0', start: cleanBody.lastIndexOf('危险源'), end: cleanBody.lastIndexOf('危险源') + 3 },
    },
  ]);
});

test('body 内联标记不能跨越 Markdown 结构化节点', async () => {
  const result = await parseImportPackage('cross-node-highlight.json', Buffer.from(JSON.stringify({
    format: 'knowledge-flashcards-material',
    version: 1,
    title: '跨节点高亮资料',
    chapters: [{ title: '章', sections: [{ title: '节', cards: [{ title: '卡', body: '[[hl:重点**内容**]]' }] }] }],
  })));

  assert.equal(result.valid, false);
  assert.match(result.issues.find((issue) => /内联高亮/.test(issue.message))?.message ?? '', /同一个 Markdown 普通文本节点/);
});

test('body 内联标记支持 GFM 表格单元格内的重复文本', async () => {
  const result = await parseImportPackage('table-inline-highlight.json', Buffer.from(JSON.stringify({
    format: 'knowledge-flashcards-material',
    version: 1,
    title: '表格内联高亮资料',
    chapters: [{
      title: '章',
      sections: [{
        title: '节',
        cards: [{
          title: '卡',
          body: [
            '| 类别 | 要点 |',
            '| --- | --- |',
            '| 第一类 | [[hl:危险源]]决定事故后果 |',
            '| 第二类 | [[hl:危险源]]决定事故发生可能性 |',
          ].join('\n'),
        }],
      }],
    }],
  })));
  const card = result.document?.chapters[0]?.sections[0]?.cards[0];
  const nodes = collectNodes(card?.content ?? []);

  assert.equal(result.valid, true);
  assert.equal(result.issues.some((issue) => issue.code === 'invalid_table'), false);
  assert.equal(nodes.find((node) => node.type === 'tableCell' && node.children?.[0]?.value === '危险源决定事故后果')?.children?.[0]?.value, '危险源决定事故后果');
  assert.equal(JSON.stringify(card?.content).includes('[[hl:'), false);
  assert.deepEqual(card?.highlights, [
    {
      kind: 'text',
      target: '危险源',
      occurrence: undefined,
      inline: true,
      anchor: { nodePath: '0.1.1.0', start: 0, end: 3 },
    },
    {
      kind: 'text',
      target: '危险源',
      occurrence: undefined,
      inline: true,
      anchor: { nodePath: '0.2.1.0', start: 0, end: 3 },
    },
  ]);
});

test('body 内联标记不能用未转义管道符跨越表格单元格', async () => {
  const result = await parseImportPackage('table-cross-cell-highlight.json', Buffer.from(JSON.stringify({
    format: 'knowledge-flashcards-material',
    version: 1,
    title: '跨单元格高亮资料',
    chapters: [{
      title: '章',
      sections: [{
        title: '节',
        cards: [{
          title: '卡',
          body: [
            '| 类别 | 要点 |',
            '| --- | --- |',
            '| 第一类 | [[hl:危险源 | 后果]] |',
          ].join('\n'),
        }],
      }],
    }],
  })));

  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.code === 'invalid_table'));
  assert.match(result.issues.find((issue) => /内联高亮/.test(issue.message))?.message ?? '', /同一个 Markdown 普通文本节点/);
});

test('内容级 JSON 的重复文本高亮必须声明 occurrence', async () => {
  const result = await parseImportPackage('ambiguous.json', Buffer.from(JSON.stringify({
    format: 'knowledge-flashcards-material',
    version: 1,
    title: '重复文本',
    chapters: [{ title: '章', sections: [{ title: '节', cards: [{ title: '卡', body: '重点，重点。', highlights: [{ text: '重点' }] }] }] }],
  })));
  assert.equal(result.valid, false);
  assert.match(result.issues.find((issue) => issue.code === 'json_schema_error')?.message ?? '', /重复出现/);
});

test('occurrence 按整张卡片 body 的正文顺序跨节点匹配', async () => {
  const result = await parseImportPackage('ordered.json', Buffer.from(JSON.stringify({
    format: 'knowledge-flashcards-material',
    version: 1,
    title: '顺序文本',
    chapters: [{
      title: '章',
      sections: [{
        title: '节',
        cards: [{
          title: '卡',
          body: '重点，**重点**，重点。',
          highlights: [
            { text: '重点', occurrence: 1 },
            { text: '重点', occurrence: 2 },
            { text: '重点', occurrence: 3 },
          ],
        }],
      }],
    }],
  })));
  const highlights = result.document?.chapters[0]?.sections[0]?.cards[0]?.highlights ?? [];
  assert.equal(result.valid, true);
  assert.deepEqual(highlights.map((highlight) => highlight.occurrence), [1, 2, 3]);
  assert.deepEqual(highlights.map((highlight) => highlight.anchor.nodePath), ['0.0', '0.1.0', '0.2']);
});

test('完整备份 JSON 不能作为普通资料导入', async () => {
  const result = await parseImportPackage('backup.json', Buffer.from(JSON.stringify({ version: 1, materials: [] })));

  assert.equal(result.sourceType, 'json');
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((item) => item.code === 'json_schema_error'));
  assert.match(result.issues[0]?.suggestion ?? '', /完整备份/);
});

test('Excel 模板可直接解析为一份资料', async () => {
  const template = await createImportTemplate('excel');
  const result = await parseImportPackage('lesson.xlsx', template.content as Buffer);

  assert.equal(template.fileName, 'knowledge-flashcards-template.xlsx');
  assert.equal(result.sourceType, 'excel');
  assert.equal(result.valid, true);
  assert.equal(result.document?.title, '示例资料');
  assert.equal(result.document?.chapters[0]?.sections[0]?.cards[0]?.title, '示例闪卡');
});

test('JSON 模板以内联文本标记为主并保留 highlights 兼容格式', async () => {
  const template = await createImportTemplate('json');
  const result = await parseImportPackage(template.fileName, Buffer.from(template.content));
  const document = JSON.parse(template.content) as {
    __使用说明: string[];
    __文本高亮主协议: {
      syntax: string;
      repeatedText: string;
      output: string;
    };
    __highlights兼容格式: { formula: string; text: string; occurrence: string };
    chapters: Array<{ title: string; sections: Array<{ cards: Array<{ title: string; body: string; highlights: Array<Record<string, unknown>> }> }> }>;
  };
  const templateCard = document.chapters[0]?.sections[0]?.cards[0];
  const card = result.document?.chapters[0]?.sections[0]?.cards[0];

  assert.equal(result.valid, true);
  assert.ok(document.__使用说明.some((rule) => /文本高亮以 body 内/.test(rule)));
  assert.match(document.__文本高亮主协议.syntax, /\[\[hl:原文\]\]/);
  assert.match(document.__文本高亮主协议.repeatedText, /不需要计算 occurrence/);
  assert.match(document.__文本高亮主协议.output, /会移除/);
  assert.match(document.__highlights兼容格式.text, /兼容旧 JSON/);
  assert.match(document.__highlights兼容格式.formula, /公式高亮/);
  assert.match(document.__highlights兼容格式.occurrence, /兼容旧 JSON/);
  assert.deepEqual(document.chapters.map((chapter) => chapter.title), ['第一章', '第二章']);
  assert.equal(document.chapters[1]?.sections[0]?.cards[0]?.title, '第二章示例闪卡');
  assert.equal(result.document?.chapters[1]?.title, '第二章');
  assert.equal(result.document?.chapters[1]?.sections[0]?.cards[0]?.title, '第二章示例闪卡');
  assert.equal(templateCard?.body.match(/\[\[hl:危险源\]\]/g)?.length, 2);
  assert.deepEqual(templateCard?.highlights, [{ formula: 'F = ma' }]);
  assert.equal(card?.highlights.length, 3);
  assert.equal(card?.highlights.filter((highlight) => highlight.kind === 'text').length, 2);
  assert.equal(card?.highlights.some((highlight) => highlight.kind === 'formula'), true);
  assert.equal(JSON.stringify(card?.content).includes('[[hl:'), false);
});

test('不支持的导入扩展名会被阻止', async () => {
  const result = await parseImportPackage('study.txt', '内容');

  assert.equal(result.valid, false);
  assert.equal(result.issues[0]?.code, 'invalid_extension');
});
