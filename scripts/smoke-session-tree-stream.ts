// 会话树分段与分支切换锚定逻辑单测
import { splitSequenceIntoSections } from "../ui-src/components/chat/sessionTreeUtil";
import type { StreamItem, EntryNode } from "../ui-src/components/chat/sessionTreeUtil";

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error(`❌ Assertion failed: ${msg}`);
    process.exit(1);
  }
}

console.log("▶ 开始测试会话树分段与分支切换锚定机制...");

const dummyNode = (id: string, text: string): EntryNode => ({
  id,
  text,
  kind: "message",
  role: "user",
});

// 测试场景 1：纯线性链（无分叉）
{
  const sequence: StreamItem[] = [
    { type: "node", node: dummyNode("1", "node 1"), isLeaf: false, onPath: true },
    { type: "node", node: dummyNode("2", "node 2"), isLeaf: true, onPath: true },
  ];

  const sections = splitSequenceIntoSections(sequence);
  assert(sections.length === 1, `无分叉时应有 1 个段，实际为 ${sections.length}`);
  assert(sections[0].fork === null, "根段的 fork 应该为 null");
  assert(sections[0].nodes.length === 2, `节点数应为 2，实际为 ${sections[0].nodes.length}`);
  console.log("✓ 测试 1 通过：纯线性链正确划分为单个根段");
}

// 测试场景 2：中间包含单个分叉点
{
  const sequence: StreamItem[] = [
    { type: "node", node: dummyNode("1", "node 1"), isLeaf: false, onPath: true },
    { type: "node", node: dummyNode("2", "node 2"), isLeaf: false, onPath: true },
    {
      type: "fork",
      parentId: "2",
      options: [dummyNode("3a", "branch A"), dummyNode("3b", "branch B")],
      selectedId: "3a",
    },
    { type: "node", node: dummyNode("3a", "branch A node"), isLeaf: true, onPath: true },
  ];

  const sections = splitSequenceIntoSections(sequence);
  assert(sections.length === 2, `包含 1 个分叉点时应有 2 个段，实际为 ${sections.length}`);
  // 上半部分
  assert(sections[0].fork === null, "第 1 段应该为根段，fork 为 null");
  assert(sections[0].nodes.length === 2, "第 1 段应该包含分叉点之上的 2 个节点");
  assert(sections[0].nodes[0].node.id === "1", "第 1 个节点为 1");
  assert(sections[0].nodes[1].node.id === "2", "第 2 个节点为 2");

  // 下半部分（切换区域）
  assert(sections[1].fork !== null, "第 2 段应该包含分叉点");
  assert(sections[1].fork?.parentId === "2", "分叉点 parentId 应该为 2");
  assert(sections[1].fork?.selectedId === "3a", "分叉点选中的分支为 3a");
  assert(sections[1].nodes.length === 1, "第 2 段应该包含分支内的 1 个节点");
  assert(sections[1].nodes[0].node.id === "3a", "分支节点为 3a");
  console.log("✓ 测试 2 通过：单个分叉点准确切分为上半部分与下半部分切换区域");
}

// 测试场景 3：根部分叉（根节点就有多个分叉）
{
  const sequence: StreamItem[] = [
    {
      type: "fork",
      parentId: "__roots__",
      options: [dummyNode("r1", "root 1"), dummyNode("r2", "root 2")],
      selectedId: "r1",
    },
    { type: "node", node: dummyNode("r1", "root 1 node"), isLeaf: false, onPath: true },
    { type: "node", node: dummyNode("r1-child", "child node"), isLeaf: true, onPath: true },
  ];

  const sections = splitSequenceIntoSections(sequence);
  assert(sections.length === 1, `根部分叉且后续无分叉时应有 1 个段，实际为 ${sections.length}`);
  assert(sections[0].fork?.parentId === "__roots__", "分叉点 parentId 应该为 __roots__");
  assert(sections[0].nodes.length === 2, "应该包含 2 个子节点");
  console.log("✓ 测试 3 通过：根部分叉段准确处理");
}

// 测试场景 4：多层嵌套分叉（分叉点内还有子分叉点）
{
  const sequence: StreamItem[] = [
    { type: "node", node: dummyNode("1", "node 1"), isLeaf: false, onPath: true },
    {
      type: "fork",
      parentId: "1",
      options: [dummyNode("2a", "branch 2a"), dummyNode("2b", "branch 2b")],
      selectedId: "2a",
    },
    { type: "node", node: dummyNode("2a", "node 2a"), isLeaf: false, onPath: true },
    {
      type: "fork",
      parentId: "2a",
      options: [dummyNode("3a1", "sub branch 1"), dummyNode("3a2", "sub branch 2")],
      selectedId: "3a1",
    },
    { type: "node", node: dummyNode("3a1", "node 3a1"), isLeaf: true, onPath: true },
  ];

  const sections = splitSequenceIntoSections(sequence);
  assert(sections.length === 3, `包含 2 个嵌套分叉点时应有 3 个段，实际为 ${sections.length}`);
  assert(sections[0].fork === null && sections[0].nodes.length === 1, "第 1 段为根部 1 个节点");
  assert(sections[1].fork?.parentId === "1" && sections[1].nodes.length === 1, "第 2 段为 fork-1 及其节点 2a");
  assert(sections[2].fork?.parentId === "2a" && sections[2].nodes.length === 1, "第 3 段为 fork-2a 及其节点 3a1");
  console.log("✓ 测试 4 通过：多层嵌套分叉点逐级准确隔离");
}

console.log("🎉 全部 4 组测试通过！会话树分段与分支切换锚定机制验证成功。");
