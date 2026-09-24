// 输入区补全 chip 节点：@ 文件 / 斜杠命令候选接受后插入的原子节点（DecoratorNode）。
// __text 即序列化文本（如 "@src/foo.ts "、"/compact "），取值与 textarea 时代
// insertFile / insertCommand 的插入文本逐字节一致（含尾随空格）——编辑器的纯文本
// 视图（flat.ts）与发送序列化都直接消费 getTextContent()，保证 WS prompt 格式不变。
// chip 不可内联编辑（原子），可整体删除（isKeyboardSelectable 默认 true）。
import { DecoratorNode, $applyNodeReplacement } from "lexical";
import type { LexicalNode, SerializedLexicalNode, Spread } from "lexical";
import type { JSX } from "react";

export type SerializedChipNode = Spread<{ text: string }, SerializedLexicalNode>;

export class ChipNode extends DecoratorNode<JSX.Element> {
  __text: string;

  static getType(): string {
    return "chip";
  }

  static clone(node: ChipNode): ChipNode {
    return new ChipNode(node.__text, node.__key);
  }

  static importJSON(json: SerializedChipNode): ChipNode {
    return $createChipNode(json.text);
  }

  constructor(text: string, key?: string) {
    super(key);
    this.__text = text;
  }

  // 序列化文本：$getRoot().getTextContent() 与 flat.ts 压平都经此取值
  getTextContent(): string {
    return this.getLatest().__text;
  }

  exportJSON(): SerializedChipNode {
    return { text: this.__text, type: ChipNode.getType(), version: 1 };
  }

  createDOM(): HTMLElement {
    // DOM 壳只承担文档流占位，视觉由 decorate() 渲染（Lexical 装饰层）
    return document.createElement("span");
  }

  updateDOM(): false {
    return false;
  }

  decorate(): JSX.Element {
    // 展示文本去掉尾随空格（那是发送文本里的分隔符，视觉间距由 chip 自身承担）
    return <span className="chip">{this.__text.replace(/ +$/, "")}</span>;
  }

  isInline(): boolean {
    return true;
  }
}

export function $createChipNode(text: string): ChipNode {
  return $applyNodeReplacement(new ChipNode(text));
}

export function $isChipNode(node: LexicalNode | null | undefined): node is ChipNode {
  return node instanceof ChipNode;
}
