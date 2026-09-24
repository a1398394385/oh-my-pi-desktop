// 类型豁免：React 19 的 @types/react 与 react-dom 运行事件注册表均无 onSelectStart
// （react-dom 客户端仅 priority map 提及 selectstart，从不注册监听，该 prop 运行时被忽略）。
// 为保持 Sidebar 原有 JSX 逐字不变（逻辑零改动），仅在此为 DOMAttributes 增补该可选属性。
import type { ReactEventHandler } from "react";

declare module "react" {
  interface DOMAttributes<T> {
    onSelectStart?: ReactEventHandler<T> | undefined;
  }
}
