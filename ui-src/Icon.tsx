// 通用图标组件：icons.js 的 icon() 返回 svg 字符串，React 侧经 dangerouslySetInnerHTML 注入。
// size 覆盖注册表默认尺寸（viewBox 不变）；className/title 透传到承载 span。
import type { CSSProperties } from "react";
import { icon } from "../ui/icons";

export interface IconProps {
  name: string;
  size?: number;
  className?: string;
  id?: string;
  title?: string;
  style?: CSSProperties;
}

export default function Icon({ name, size, className, id, title, style }: IconProps) {
  const svg = icon(name, size);
  if (!svg) return null;
  return <span className={className} id={id} title={title} style={style} dangerouslySetInnerHTML={{ __html: svg }} />;
}
